"""Feature 6: instant replay on calls.

The captions relay (app/services/captions.py) already receives every member's mic
(PCM16 LE, 24 kHz, mono), so each call keeps the last BUFFER_MS of each stream plus the
finished caption turns. Signals mark a moment worth replaying:

- 3+ people talking at once (voiced frames from 3+ mics within OVERLAP_MS),
- a loudness spike (laughter shows up as volume, not words) vs the call's baseline,
- a ? tap on the call (calls.explain_call),
- phrases like "no way" / "remember when", or a glossary term said aloud.

A signal waits SETTLE_S (to catch the reaction), then saves the last CLIP_MS mixed to a
WAV in MEDIA_DIR with the caption timeline, has Muse title it from the captions, and
suggests it to everyone on the call as `source="call"` lore (its events: the
caption lines around the signal; see lore._events). One moment, one suggestion:
signals within DEBOUNCE_MS of the last one are ignored.
"""

import array
import asyncio
import io
import logging
import math
import re
import time
import uuid
import wave
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select

from app.core import db
from app.core.config import settings
from app.models import Call, CallMember, Lore, LoreReplay, User
from app.services import embeddings, llm
from app.services import lore as lore_service

log = logging.getLogger(__name__)

RATE = 24_000
BYTES_PER_MS = RATE * 2 // 1000
BUFFER_MS = 32_000
CLIP_MS = 30_000
VOICE_RMS = 500.0  # a frame this loud counts as someone talking
OVERLAP_MS = 1_500
OVERLAP_SPEAKERS = 3
SPIKE_FACTOR = 3.0  # loudness spike: this many times the voiced baseline ...
SPIKE_MIN_RMS = 4_000.0  # ... and at least this loud
SPIKE_MS = 400  # ... for this long
BASELINE_ALPHA = 0.02
SETTLE_S = 4.0
DEBOUNCE_MS = 45_000
PHRASES = re.compile(
    r"\b(no way|remember when|that'?s crazy|i can'?t believe|bro what|"
    r"no shot|not again|you'?re kidding|oh my god)\b",
    re.IGNORECASE,
)

REPLAY_SYSTEM = (
    """A group of friends is on a call. You get the captions of the last \
30 seconds, `<name>: text`. Decide whether this is a moment the group would want to \
keep as lore: something funny, a story, an inside joke, big news, a memorable \
reaction. Use only the captions; never invent what happened.
Return only JSON: {"keep": bool, "title": str, "story": str, "terms": [str]}
- title: """
    + lore_service.TITLE_RULE
    + """
- story: 1-2 plain sentences: what happened.
- terms: inside terms or nicknames said, as written."""
)


@dataclass
class Turn:
    user_id: str
    text: str
    start_ms: int
    end_ms: int


@dataclass
class CallMoments:
    call_id: int
    group_id: int
    keywords: list[str] = field(default_factory=list)
    frames: dict[str, deque[tuple[int, bytes]]] = field(default_factory=dict)
    voiced: dict[str, int] = field(default_factory=dict)  # user -> last voiced ms
    turns: deque[Turn] = field(default_factory=deque)
    baseline: float = 0.0
    loud_since: int | None = None
    last_fired: int = -DEBOUNCE_MS
    task: asyncio.Task[None] | None = None

    def add_audio(self, user_id: str, frame: bytes, at_ms: int) -> None:
        q = self.frames.setdefault(user_id, deque())
        q.append((at_ms, frame))
        while q and q[0][0] < at_ms - BUFFER_MS:
            q.popleft()
        level = rms(frame)
        if level < VOICE_RMS:
            if self.loud_since is not None and at_ms - self.loud_since > SPIKE_MS * 3:
                self.loud_since = None
            return
        self.voiced[user_id] = at_ms
        talking = sum(at_ms - t <= OVERLAP_MS for t in self.voiced.values())
        if talking >= OVERLAP_SPEAKERS:
            self.signal("overlap", at_ms)
        spike = max(self.baseline * SPIKE_FACTOR, SPIKE_MIN_RMS)
        if self.baseline and level >= spike:
            self.loud_since = self.loud_since if self.loud_since is not None else at_ms
            if at_ms - self.loud_since >= SPIKE_MS:
                self.signal("loud", at_ms)
        else:
            self.loud_since = None
        self.baseline += (
            BASELINE_ALPHA * (level - self.baseline) if self.baseline else level
        )

    def add_turn(self, user_id: str, text: str, start_ms: int, end_ms: int) -> None:
        self.turns.append(Turn(user_id, text, start_ms, end_ms))
        while self.turns and self.turns[0].end_ms < end_ms - BUFFER_MS:
            self.turns.popleft()
        if PHRASES.search(text):
            self.signal("phrase", end_ms)
        elif any(_said(k, text) for k in self.keywords):
            self.signal("term", end_ms)

    def signal(self, kind: str, at_ms: int | None = None) -> None:
        at_ms = at_ms if at_ms is not None else now_ms()
        if at_ms - self.last_fired < DEBOUNCE_MS:
            return
        self.last_fired = at_ms
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self.task = loop.create_task(self._fire(kind))
        _tasks.add(self.task)
        self.task.add_done_callback(_tasks.discard)

    async def _fire(self, kind: str) -> None:
        try:
            await asyncio.sleep(SETTLE_S)
            await save(self, kind)
        except Exception:
            log.exception("replay failed on call %s", self.call_id)

    def clip(self, end_ms: int) -> tuple[bytes, int, list[dict[str, Any]]]:
        """The last CLIP_MS of every mic mixed (WAV bytes), its start, and the
        caption timeline as offsets into it."""
        start = end_ms - CLIP_MS
        mix = array.array("i", bytes(4 * CLIP_MS * RATE // 1000))
        for q in self.frames.values():
            for at, frame in q:
                if at < start or at > end_ms:
                    continue
                pcm = array.array("h", frame[: len(frame) - len(frame) % 2])
                offset = (at - start) * RATE // 1000
                for i, sample in enumerate(pcm):
                    j = offset + i
                    if j >= len(mix):
                        break
                    mix[j] += sample
        out = array.array("h", (max(-32768, min(32767, s)) for s in mix))
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(out.tobytes())
        captions = [
            {
                "user_id": t.user_id,
                "text": t.text,
                "start_ms": max(0, t.start_ms - start),
                "end_ms": min(CLIP_MS, t.end_ms - start),
            }
            for t in self.turns
            if t.end_ms >= start and t.start_ms <= end_ms
        ]
        return buf.getvalue(), start, captions


def rms(frame: bytes) -> float:
    pcm = array.array("h", frame[: len(frame) - len(frame) % 2])
    if not pcm:
        return 0.0
    return math.sqrt(sum(s * s for s in pcm) / len(pcm))


def _said(term: str, text: str) -> bool:
    return bool(re.search(rf"(?<!\w){re.escape(term)}(?!\w)", text, re.IGNORECASE))


def now_ms() -> int:
    return int(time.time() * 1000)


calls: dict[int, CallMoments] = {}
_tasks: set[asyncio.Task[None]] = set()


def moments(call_id: int, group_id: int, keywords: list[str]) -> CallMoments:
    m = calls.get(call_id)
    if m is None:
        m = calls[call_id] = CallMoments(call_id, group_id, list(keywords))
    return m


def signal(call_id: int, kind: str) -> None:
    """External signals (a ? tap) for a call that is streaming audio."""
    if m := calls.get(call_id):
        m.signal(kind)


def forget(call_id: int) -> None:
    calls.pop(call_id, None)


async def save(m: CallMoments, kind: str) -> Lore | None:
    end_ms = now_ms()
    wav, start_ms, captions = await asyncio.to_thread(m.clip, end_ms)
    if not captions:
        return None
    async with db.SessionLocal() as session:
        users = {
            u.id: u.display_name
            for u in await session.scalars(
                select(User).where(User.id.in_({c["user_id"] for c in captions}))
            )
        }
        transcript = "\n".join(
            f"{users.get(c['user_id'], 'Someone')}: {c['text']}" for c in captions
        )
        data = await llm.complete_json(REPLAY_SYSTEM, transcript, max_tokens=2000)
        if not data.get("keep"):
            return None
        title = " ".join(str(data.get("title") or "").split()).strip("\"'")[:80]
        story = " ".join(str(data.get("story") or "").split())[:400]
        if not title or not story:
            return None
        name = f"{uuid.uuid4().hex}.wav"
        path = settings.MEDIA_DIR / name
        path.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(path.write_bytes, wav)
        started = datetime.fromtimestamp(start_ms / 1000, UTC)
        ended = datetime.fromtimestamp(end_ms / 1000, UTC)
        replay = LoreReplay(
            call_id=m.call_id,
            group_id=m.group_id,
            audio_path=name,
            duration_ms=end_ms - start_ms,
            started_at=started,
            captions=captions,
            signal=kind,
        )
        session.add(replay)
        await session.flush()
        terms = [
            " ".join(t.split())
            for t in data.get("terms") or []
            if isinstance(t, str) and t.strip()
        ][:6]
        lore = Lore(
            group_id=m.group_id,
            title=title,
            story=story,
            status="suggested",
            source="call",
            call_id=m.call_id,
            started_at=started,
            ended_at=ended,
            people=list(dict.fromkeys(c["user_id"] for c in captions)),
            terms=terms,
            message_ids=[],
            replay_ids=[replay.id],
            score=0.0,
            embedding=await embeddings.embed(f"{title}. {story} {' '.join(terms)}"),
        )
        session.add(lore)
        await lore_service.refresh_events(session, lore)
        await session.commit()
        on_call = list(
            await session.scalars(
                select(CallMember.user_id).where(
                    CallMember.call_id == m.call_id, CallMember.left_at.is_(None)
                )
            )
        )
        call = await session.get(Call, m.call_id)
        if call is None or call.ended_at is not None:
            return lore
        await lore_service.announce(session, lore, on_call)
        return lore


async def drain() -> None:
    """Wait for pending replays (tests, scripts)."""
    while _tasks:
        await asyncio.gather(*_tasks, return_exceptions=True)
