import time
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from httpx_ws import AsyncWebSocketSession, WebSocketDisconnect, aconnect_ws
from httpx_ws.transport import ASGIWebSocketTransport
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.main import app
from app.models import Call, CallTranscript, Glossary
from app.seed import LoadedFixture
from app.services import calls, captions, llm, nudge
from tests.conftest import WsConnect

URL = "/api/v1"


@pytest.fixture(autouse=True)
def _clear_nudge_caches() -> Iterator[None]:
    nudge.invalidate_glossary()  # group ids repeat across tests (RESTART IDENTITY)
    yield
    nudge.invalidate_glossary()


def now_ms() -> int:
    return int(time.time() * 1000)


async def _join(client: AsyncClient, gid: int, user: str) -> dict[str, Any]:
    resp = await client.post(f"{URL}/groups/{gid}/call", json={"user_id": user})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _backdate(session: AsyncSession, call_id: int, minutes: int = 10) -> None:
    await session.execute(
        update(Call)
        .where(Call.id == call_id)
        .values(started_at=datetime.now(UTC) - timedelta(minutes=minutes))
    )
    await session.commit()


async def _say(
    session: AsyncSession, call_id: int, user: str, text: str, start_ms: int
) -> None:
    """Store a finished turn, as the captions relay does."""
    end_ms = start_ms + 300 * len(text.split())
    session.add(
        CallTranscript(
            call_id=call_id,
            result_id=f"t-{user}-{start_ms}",
            speaker_id=user,
            start_ms=start_ms,
            end_ms=end_ms,
            text=text,
            items=captions.word_items(user, text, start_ms, end_ms),
            is_partial=False,
        )
    )
    await session.commit()


@asynccontextmanager
async def _mic(call_id: int, user: str) -> AsyncIterator[AsyncWebSocketSession]:
    transport = ASGIWebSocketTransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        async with aconnect_ws(f"{URL}/calls/{call_id}/audio?user_id={user}", c) as ws:
            yield ws


async def _caption(ws: AsyncWebSocketSession) -> dict[str, Any]:
    while True:
        frame = await ws.receive_json(timeout=2)
        if frame["type"] == "call.caption":
            return frame["data"]


# ---------------------------------------------------------------- lifecycle


async def test_start_join_leave_and_end(
    client: AsyncClient,
    ws_connect: WsConnect,
    sample: LoadedFixture,
    fake_chime: calls.FakeChime,
) -> None:
    gid = sample.group_id("volleyball")
    assert (await client.get(f"{URL}/groups/{gid}/call")).json() is None

    async with ws_connect("maya") as maya:
        first = await _join(client, gid, "swayam")
        frame = await maya.receive_json(timeout=2)
        assert frame["type"] == "call.updated"
        assert frame["data"]["id"] == first["call"]["id"]

    call_id = first["call"]["id"]
    meeting_id = first["meeting"]["MeetingId"]
    assert first["attendee"]["ExternalUserId"] == "swayam"
    assert first["call"]["started_by"] == "swayam"

    second = await _join(client, gid, "priya")
    assert second["call"]["id"] == call_id  # one active call per group
    assert second["meeting"]["MeetingId"] == meeting_id
    active = (await client.get(f"{URL}/groups/{gid}/call")).json()
    assert [m["user"]["id"] for m in active["members"]] == ["swayam", "priya"]

    resp = await client.post(f"{URL}/calls/{call_id}/leave", json={"user_id": "swayam"})
    assert resp.json()["ended_at"] is None  # priya is still on
    resp = await client.post(f"{URL}/calls/{call_id}/leave", json={"user_id": "priya"})
    assert resp.json()["ended_at"] is not None  # last one out ends it
    assert fake_chime.deleted == [meeting_id]
    assert (await client.get(f"{URL}/groups/{gid}/call")).json() is None

    again = await _join(client, gid, "priya")
    assert again["call"]["id"] != call_id


async def test_meeting_gone_starts_a_new_call(
    client: AsyncClient, sample: LoadedFixture, fake_chime: calls.FakeChime
) -> None:
    gid = sample.group_id("volleyball")
    first = await _join(client, gid, "swayam")
    fake_chime.meetings.clear()  # Chime ended the empty meeting on its own
    second = await _join(client, gid, "priya")
    assert second["call"]["id"] != first["call"]["id"]


async def test_only_call_members_can_call_or_stream(
    client: AsyncClient, sample: LoadedFixture
) -> None:
    gid = sample.group_id("volleyball")
    resp = await client.post(f"{URL}/groups/{gid}/call", json={"user_id": "nobody"})
    assert resp.status_code in (403, 404)
    call_id = (await _join(client, gid, "swayam"))["call"]["id"]
    # in the group, not on the call: the socket is refused (surfaces as a group)
    with pytest.raises((WebSocketDisconnect, ExceptionGroup)):
        async with _mic(call_id, "maya") as ws:
            await ws.receive_json(timeout=2)
    dm = sample.group_id("dm_maya_jordan")
    assert (await client.get(f"{URL}/groups/{dm}/call")).json() is None


# ------------------------------------------------------------------ captions


async def test_mic_stream_becomes_captions_and_turns(
    client: AsyncClient,
    session: AsyncSession,
    ws_connect: WsConnect,
    sample: LoadedFixture,
) -> None:
    gid = sample.group_id("volleyball")
    call_id = (await _join(client, gid, "swayam"))["call"]["id"]
    await _join(client, gid, "priya")

    async with ws_connect("priya") as priya, _mic(call_id, "swayam") as mic:
        assert await mic.receive_json(timeout=2) == {"type": "ready"}
        await mic.send_bytes(b"grandmas after")
        first = await _caption(priya)
        await mic.send_bytes(b"the game")
        second = await _caption(priya)
        assert captions.live_turns[call_id]  # mid-sentence: visible to the ? button
        await mic.send_bytes(b"")  # end of turn
        done = await _caption(priya)

    assert (first["user_id"], first["text"], first["final"]) == (
        "swayam",
        "grandmas after",
        False,
    )
    assert second["text"] == "grandmas after the game"  # cumulative within a turn
    assert second["turn_id"] == first["turn_id"]
    assert (done["text"], done["final"]) == ("grandmas after the game", True)
    rows = (await session.scalars(select(CallTranscript))).all()
    assert [(r.speaker_id, r.text, r.is_partial) for r in rows] == [
        ("swayam", "grandmas after the game", False)
    ]
    assert [i["content"] for i in rows[0].items] == ["grandmas", "after", "the", "game"]


async def test_muse_reconnects_for_the_same_mic(
    client: AsyncClient,
    sample: LoadedFixture,
    fake_asr: captions.FakeASR,
) -> None:
    gid = sample.group_id("volleyball")
    call_id = (await _join(client, gid, "swayam"))["call"]["id"]
    async with _mic(call_id, "swayam") as mic:
        assert await mic.receive_json(timeout=2) == {"type": "ready"}
        await fake_asr.sessions[0].close()  # Muse ends the session (60 min limit)
        assert await mic.receive_json(timeout=2) == {"type": "ready"}
    assert len(fake_asr.sessions) == 2
    assert "Grandma" in fake_asr.sessions[0].keywords  # glossary guides spelling


def test_clip_keeps_only_words_inside_the_window() -> None:
    t = 1_000_000
    rows = [
        CallTranscript(
            speaker_id="swayam",
            start_ms=t,
            end_ms=t + 1200,
            text="meet at grandma's later",
            items=captions.word_items("swayam", "meet at grandma's later", t, t + 1200),
        ),
        CallTranscript(
            speaker_id=None,
            start_ms=t + 2000,
            end_ms=t + 3000,
            text="no word timings",
            items=[],
        ),
    ]
    # words are 300 ms apart: "at" ends at t+600, "later" starts at t+900
    assert calls.clip(rows, t + 601, t + 950) == [("swayam", "grandma's later")]
    assert calls.clip(rows, t, t + 3000) == [
        ("swayam", "meet at grandma's later"),
        (None, "no word timings"),
    ]
    assert calls.clip(rows, t + 2500, t + 3000) == []  # r2 isn't fully inside


# ---------------------------------------------------------------- ? button


async def test_question_button_explains_with_chat_history(
    client: AsyncClient,
    session: AsyncSession,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    gid = sample.group_id("volleyball")
    call_id = (await _join(client, gid, "swayam"))["call"]["id"]
    await _join(client, gid, "priya")
    await _backdate(session, call_id)
    grandma = await session.scalar(select(Glossary).where(Glossary.term == "Grandma"))
    assert grandma is not None
    at = now_ms()
    await _say(session, call_id, "jordan", "ok who is bringing snacks", at - 90_000)
    await _say(session, call_id, "maya", "this is way too old", at - 400_000)
    # swayam is mid-sentence when priya taps ?
    captions.live_turns[call_id] = {
        "swayam:0:0": captions.LiveTurn(
            "swayam", "grandma's after the game", at - 4000, at - 2800
        )
    }

    def answer(call: llm.LLMCall) -> dict[str, Any]:
        assert "CALL BACKGROUND:\n[T1 Jordan" in call.user
        assert "[T2 Swayam" in call.user and "grandma's after the game" in call.user
        assert "too old" not in call.user  # outside the 2 min background
        assert f"[G{grandma.id}] Grandma" in call.user  # chat history joins in
        assert "EXPLAINING TO: Priya" in call.user
        return {
            "term": "Grandma",
            "meaning": "**Grandma's** is Swayam's house.",
            "kind": "nickname",
            "confidence": 0.9,
            "glossary_ids": [grandma.id],
            "said_in": 2,
        }

    fake_llm.handler = answer
    resp = await client.post(
        f"{URL}/calls/{call_id}/explain", json={"user_id": "priya", "at_ms": at}
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert (out["status"], out["term"], out["call_id"]) == (
        "explained",
        "Grandma",
        call_id,
    )
    assert out["said_by"]["id"] == "swayam"
    assert out["sources"]  # the glossary's source messages from the chat
    assert out["heard"] is None

    # follow-ups reuse the call context through the feature 1 endpoint
    fake_llm.handler = lambda call: {
        "term": "Grandma",
        "meaning": "Because of the plastic-covered couches.",
        "kind": "nickname",
        "confidence": 0.9,
        "glossary_ids": [grandma.id],
    }
    resp = await client.post(
        f"{URL}/explain",
        json={
            "group_id": gid,
            "user_id": "priya",
            "explanation_id": out["explanation_id"],
            "follow_up": "why grandma?",
        },
    )
    assert resp.json()["call_id"] == call_id
    assert "[T2 Swayam" in fake_llm.calls[-1].user


async def test_unknown_on_a_call_says_what_it_heard(
    client: AsyncClient,
    session: AsyncSession,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    gid = sample.group_id("volleyball")
    call_id = (await _join(client, gid, "jordan"))["call"]["id"]
    await _join(client, gid, "priya")
    await _say(session, call_id, "jordan", "bro you're getting procs", now_ms() - 3000)
    fake_llm.queue({"term": "procs", "meaning": "?", "kind": "unknown", "said_in": 1})
    out = (
        await client.post(
            f"{URL}/calls/{call_id}/explain",
            json={"user_id": "priya", "at_ms": now_ms()},
        )
    ).json()
    assert out["status"] == "unknown"
    assert out["heard"] == "…procs…"
    assert out["said_by"]["id"] == "jordan"
    assert out["ask"]["user"]["id"] == "jordan"  # ask whoever said it


async def test_no_recent_speech(client: AsyncClient, sample: LoadedFixture) -> None:
    gid = sample.group_id("volleyball")
    call_id = (await _join(client, gid, "swayam"))["call"]["id"]
    out = (
        await client.post(
            f"{URL}/calls/{call_id}/explain",
            json={"user_id": "swayam", "at_ms": now_ms()},
        )
    ).json()
    assert (out["status"], out["meaning"]) == ("no_speech", calls.NO_SPEECH)
    resp = await client.post(
        f"{URL}/explain",
        json={
            "group_id": gid,
            "user_id": "swayam",
            "explanation_id": out["explanation_id"],
            "follow_up": "what?",
        },
    )
    assert resp.status_code == 422
