"""Feature 4 captions: relay each member's microphone to Muse realtime speech-to-text.

Each phone streams only its own mic (PCM16 LE, 24 kHz, mono) to `relay`, so every
caption belongs to exactly one member. Muse answers with cumulative partials per turn
(`transcript`) and a final `speechComplete`; partials fan out to the call as
`call.caption`, finals are stored in `call_transcripts` for the ? button. Turns still in
progress live in `live_turns` so a ? tap mid-sentence sees them too.

Muse sessions last up to an hour and close if audio stops arriving in real time; the
relay reopens a session for as long as the phone stays connected.

Test seam: `set_asr(factory)` / `set_asr(None)`; `FakeASR` turns scripted text into
Muse events (the autouse `fake_asr` pytest fixture installs one).
"""

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from fastapi import WebSocket, WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app import schemas
from app.core import db
from app.core.config import settings
from app.models import Call, CallMember, CallTranscript, Glossary
from app.services import replays
from app.services.realtime import hub

log = logging.getLogger(__name__)

MUSE_URL = "wss://api.meta.ai/v1/asr/realtime"
MUSE_MODEL = "muse-voice-transcribe-1.0"
MEMBERS_TTL_S = 5.0  # how stale the caption audience may get
MAX_KEYWORDS = 50  # glossary terms that guide Muse's spelling ("procs", not "prox")
RETRY_S = 1.0


class ASRSession(Protocol):
    async def send(self, pcm: bytes) -> None: ...
    def events(self) -> AsyncIterator[dict[str, Any]]: ...
    async def close(self) -> None: ...


class MuseSession:
    def __init__(self, ws: Any) -> None:
        self._ws = ws

    @classmethod
    async def open(cls, keywords: list[str]) -> "MuseSession":
        import websockets

        ws = await websockets.connect(MUSE_URL, open_timeout=10, max_size=None)
        handshake: dict[str, Any] = {
            "mode": "ENDPOINTING",
            "authorization": {"accessToken": f"Bearer {settings.MODEL_API_KEY}"},
            "audioEncoding": "PCM_24KHZ",
            "model": MUSE_MODEL,
            "partialMode": "CUMULATIVE",
        }
        if keywords:
            handshake["keywords"] = keywords
        await ws.send(json.dumps(handshake))
        reply = json.loads(await asyncio.wait_for(ws.recv(), 10))
        if reply.get("type") == "error" or not reply.get("sessionId"):
            await ws.close()
            raise RuntimeError(f"Muse handshake failed: {reply.get('message', reply)}")
        return cls(ws)

    async def send(self, pcm: bytes) -> None:
        await self._ws.send(pcm)

    async def events(self) -> AsyncIterator[dict[str, Any]]:
        async for raw in self._ws:
            if isinstance(raw, str):
                yield json.loads(raw)

    async def close(self) -> None:
        with contextlib.suppress(Exception):
            await self._ws.send(json.dumps({"type": "endStream"}))
        await self._ws.close()


class FakeASR:
    """Each binary frame is UTF-8 text standing in for audio: a frame "grandmas after"
    yields a cumulative partial; an empty frame ends the turn (`speechComplete`)."""

    def __init__(self) -> None:
        self.sessions: list[FakeASR.Session] = []

    async def open(self, keywords: list[str]) -> "FakeASR.Session":
        session = FakeASR.Session()
        session.keywords = keywords
        self.sessions.append(session)
        return session

    class Session:
        def __init__(self) -> None:
            self.keywords: list[str] = []
            self.queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
            self.turn = 0
            self.text = ""

        async def send(self, pcm: bytes) -> None:
            words = pcm.decode(errors="ignore").strip()
            if words:
                if not self.text:
                    await self.queue.put(
                        {"type": "speechStart", "turnId": str(self.turn)}
                    )
                self.text = f"{self.text} {words}".strip()
                await self.queue.put({"type": "transcript", "transcript": self.text})
            elif self.text:
                await self.queue.put(
                    {
                        "type": "speechComplete",
                        "turnId": str(self.turn),
                        "transcript": self.text,
                    }
                )
                self.turn, self.text = self.turn + 1, ""

        async def events(self) -> AsyncIterator[dict[str, Any]]:
            while (event := await self.queue.get()) is not None:
                yield event

        async def close(self) -> None:
            await self.queue.put(None)


_open_asr: Callable[[], Any] = MuseSession.open


def set_asr(factory: Callable[[], Any] | None) -> None:
    """Install an ASR session factory (tests); None restores Muse."""
    global _open_asr
    _open_asr = factory if factory is not None else MuseSession.open


# ------------------------------------------------------------------- turns


@dataclass
class LiveTurn:
    user_id: str
    text: str
    start_ms: int
    end_ms: int


# call_id -> turn key -> the turn as heard so far (dropped once stored)
live_turns: dict[int, dict[str, LiveTurn]] = {}


def now_ms() -> int:
    return int(time.time() * 1000)


def word_items(user_id: str, text: str, start_ms: int, end_ms: int) -> list[dict]:
    """Spread a turn's words evenly over its span, so the ? button can clip a turn
    that crosses the 45 s cutoff (Muse gives no per-word timings)."""
    words = text.split()
    step = (end_ms - start_ms) / max(len(words), 1)
    return [
        {
            "type": "pronunciation",
            "content": w,
            "startTimeMs": int(start_ms + i * step),
            "endTimeMs": int(start_ms + (i + 1) * step),
            "attendee": {"attendeeId": "", "externalUserId": user_id},
        }
        for i, w in enumerate(words)
    ]


@dataclass
class _Relay:
    call_id: int
    user_id: str
    session_no: int = 0
    turn_no: int = 0
    turn: LiveTurn | None = None
    moments: replays.CallMoments | None = None  # instant replay buffer (feature 6)
    audience: list[str] = field(default_factory=list)
    audience_at: float = 0.0

    @property
    def turn_key(self) -> str:
        return f"{self.user_id}:{self.session_no}:{self.turn_no}"

    async def members(self) -> list[str]:
        if time.monotonic() - self.audience_at > MEMBERS_TTL_S:
            async with db.SessionLocal() as session:
                self.audience = list(
                    await session.scalars(
                        select(CallMember.user_id).where(
                            CallMember.call_id == self.call_id,
                            CallMember.left_at.is_(None),
                        )
                    )
                )
            self.audience_at = time.monotonic()
        return self.audience

    async def caption(self, text: str, final: bool) -> None:
        frame = schemas.CallCaption(
            call_id=self.call_id,
            user_id=self.user_id,
            turn_id=self.turn_key,
            text=text,
            final=final,
            ts=datetime.now(UTC),
        )
        await hub.send(await self.members(), "call.caption", frame)

    async def on_event(self, event: dict[str, Any]) -> None:
        kind = event.get("type")
        text = event.get("transcript")
        if kind == "speechStart" or (kind == "transcript" and self.turn is None):
            if not (kind == "transcript" and not text):
                self.turn = LiveTurn(self.user_id, "", now_ms(), now_ms())
                live_turns.setdefault(self.call_id, {})[self.turn_key] = self.turn
        if kind == "transcript" and isinstance(text, str) and text and self.turn:
            self.turn.text, self.turn.end_ms = text, now_ms()
            await self.caption(text, final=False)
        elif kind == "speechComplete" and isinstance(text, str):
            turn = self.turn or LiveTurn(self.user_id, text, now_ms(), now_ms())
            turn.text, turn.end_ms = text, now_ms()
            if text.strip():
                await self.store(turn)
                await self.caption(text, final=True)
                if self.moments is not None:
                    self.moments.add_turn(
                        self.user_id, text, turn.start_ms, turn.end_ms
                    )
            live_turns.get(self.call_id, {}).pop(self.turn_key, None)
            self.turn, self.turn_no = None, self.turn_no + 1
        elif kind == "error":
            log.warning("Muse error on call %s: %s", self.call_id, event.get("message"))

    async def store(self, turn: LiveTurn) -> None:
        async with db.SessionLocal() as session:
            await session.execute(
                pg_insert(CallTranscript)
                .values(
                    call_id=self.call_id,
                    result_id=f"muse:{self.turn_key}:{turn.start_ms}",
                    speaker_id=self.user_id,
                    start_ms=turn.start_ms,
                    end_ms=turn.end_ms,
                    text=turn.text,
                    items=word_items(
                        self.user_id, turn.text, turn.start_ms, turn.end_ms
                    ),
                    is_partial=False,
                )
                .on_conflict_do_nothing()
            )
            await session.commit()


async def relay(ws: WebSocket, call_id: int, user_id: str) -> None:
    """Pump one member's mic audio to Muse until they hang up."""
    async with db.SessionLocal() as session:
        call = await session.get(Call, call_id)
        member = await session.get(CallMember, (call_id, user_id))
        if call is None or call.ended_at is not None or member is None:
            await ws.close(code=1008, reason="Not on this call")
            return
        rows = await session.execute(
            select(Glossary.term, Glossary.aliases).where(
                Glossary.group_id == call.group_id
            )
        )
        keywords = list(
            dict.fromkeys(f for term, aliases in rows for f in (term, *aliases))
        )[:MAX_KEYWORDS]
    await ws.accept()
    state = _Relay(call_id, user_id)
    state.moments = replays.moments(call_id, call.group_id, keywords)
    audio: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=200)

    async def receive() -> None:
        try:
            while True:
                frame = await ws.receive_bytes()
                state.moments.add_audio(user_id, frame, now_ms())
                if audio.full():  # Muse stalled: drop the oldest frame, stay live
                    audio.get_nowait()
                audio.put_nowait(frame)
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            await audio.put(None)

    async def transcribe() -> None:
        while True:
            try:
                asr = await _open_asr(keywords)
            except Exception as exc:
                log.warning("Muse connect failed for call %s: %r", call_id, exc)
                with contextlib.suppress(Exception):
                    await ws.send_json(
                        {"type": "error", "message": "Captions unavailable"}
                    )
                await asyncio.sleep(RETRY_S)
                if audio.empty() and receiver.done():
                    return
                continue
            with contextlib.suppress(Exception):
                await ws.send_json({"type": "ready"})

            async def pump() -> None:
                while (frame := await audio.get()) is not None:
                    await asr.send(frame)
                await asr.close()

            sender = asyncio.create_task(pump())
            try:
                async for event in asr.events():
                    await state.on_event(event)
            except Exception as exc:
                log.info("Muse stream for call %s ended: %r", call_id, exc)
            if not sender.done():
                sender.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await sender
            else:
                return  # the phone hung up and Muse flushed its last turn
            live_turns.get(call_id, {}).pop(state.turn_key, None)
            state.session_no, state.turn_no, state.turn = state.session_no + 1, 0, None
            if receiver.done():
                return

    receiver = asyncio.create_task(receive())
    try:
        await transcribe()
    finally:
        receiver.cancel()
        live_turns.get(call_id, {}).pop(state.turn_key, None)
        if not live_turns.get(call_id):
            live_turns.pop(call_id, None)
