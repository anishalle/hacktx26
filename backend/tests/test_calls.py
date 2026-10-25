import time
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Call, CallTranscript, Glossary
from app.seed import LoadedFixture
from app.services import calls, llm, nudge
from tests.conftest import WsConnect

URL = "/api/v1"


@pytest.fixture(autouse=True)
def _clear_nudge_caches() -> Iterator[None]:
    nudge.invalidate_glossary()  # group ids repeat across tests (RESTART IDENTITY)
    yield
    nudge.invalidate_glossary()


def now_ms() -> int:
    return int(time.time() * 1000)


def result(
    rid: str, speaker: str, text: str, start: int, *, partial: bool = False
) -> dict[str, Any]:
    """A Chime result with one 300 ms word item per word, starting at `start`."""
    words = text.split()
    items = [
        {
            "type": "pronunciation",
            "content": w,
            "startTimeMs": start + i * 300,
            "endTimeMs": start + i * 300 + 250,
            "attendee": {"attendeeId": f"a-{speaker}", "externalUserId": speaker},
        }
        for i, w in enumerate(words)
    ]
    return {
        "resultId": rid,
        "isPartial": partial,
        "startTimeMs": start,
        "endTimeMs": start + max(len(words), 1) * 300,
        "alternatives": [{"transcript": text, "items": items}],
    }


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
    assert meeting_id in fake_chime.transcribing  # transcription starts with the call
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


async def test_only_group_members_can_call(
    client: AsyncClient, sample: LoadedFixture
) -> None:
    gid = sample.group_id("volleyball")
    resp = await client.post(f"{URL}/groups/{gid}/call", json={"user_id": "nobody"})
    assert resp.status_code in (403, 404)
    call_id = (await _join(client, gid, "swayam"))["call"]["id"]
    dm = sample.group_id("dm_maya_jordan")
    resp = await client.post(
        f"{URL}/calls/{call_id}/transcripts", json={"user_id": "nobody", "results": []}
    )
    assert resp.status_code in (403, 404)
    assert (await client.get(f"{URL}/groups/{dm}/call")).json() is None


# --------------------------------------------------------------- transcripts


async def test_finals_dedupe_and_never_regress(
    client: AsyncClient, session: AsyncSession, sample: LoadedFixture
) -> None:
    gid = sample.group_id("volleyball")
    call_id = (await _join(client, gid, "swayam"))["call"]["id"]
    t = now_ms() - 3000
    final = result("r1", "swayam", "grandma's after the game", t)
    url = f"{URL}/calls/{call_id}/transcripts"

    for user in ("swayam", "priya"):  # every client forwards the same final
        resp = await client.post(url, json={"user_id": user, "results": [final]})
        assert resp.json() == {"stored": 1}
    partial = result("r2", "swayam", "bring", t + 1500, partial=True)
    resp = await client.post(url, json={"user_id": "swayam", "results": [partial]})
    assert resp.json() == {"stored": 0}  # partials are captions only

    # a late partial for r1 (via the ? button's pending results) can't overwrite it
    late = result("r1", "swayam", "grandma's", t, partial=True)
    await client.post(
        f"{URL}/calls/{call_id}/explain",
        json={
            "user_id": "priya",
            "at_ms": now_ms() - 60_000,
            "pending_results": [late],
        },
    )
    rows = (await session.scalars(select(CallTranscript))).all()
    assert [(r.result_id, r.text, r.is_partial, r.speaker_id) for r in rows] == [
        ("r1", "grandma's after the game", False, "swayam")
    ]

    old = result("r3", "swayam", "too old", t - 3_600_000)
    resp = await client.post(url, json={"user_id": "swayam", "results": [old]})
    assert resp.status_code == 422
    future = result("r4", "swayam", "from the future", now_ms() + 60_000)
    resp = await client.post(url, json={"user_id": "swayam", "results": [future]})
    assert resp.status_code == 422


def test_clip_keeps_only_words_inside_the_window() -> None:
    t = 1_000_000
    rows = [
        CallTranscript(
            result_id="r1",
            speaker_id="swayam",
            start_ms=t,
            end_ms=t + 1200,
            text="meet at grandma's later",
            items=result("r1", "swayam", "meet at grandma's later", t)["alternatives"][
                0
            ]["items"],
            is_partial=False,
        ),
        CallTranscript(
            result_id="r2",
            speaker_id=None,
            start_ms=t + 2000,
            end_ms=t + 3000,
            text="no word timings",
            items=[],
            is_partial=False,
        ),
    ]
    assert calls.clip(rows, t + 600, t + 950) == [("swayam", "grandma's later")]
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
    await client.post(
        f"{URL}/calls/{call_id}/transcripts",
        json={
            "user_id": "swayam",
            "results": [
                result("bg", "jordan", "ok who is bringing snacks", at - 90_000),
                result("old", "maya", "this is way too old", at - 400_000),
            ],
        },
    )
    pending = [result("now", "swayam", "grandma's after the game", at - 4000)]

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
        f"{URL}/calls/{call_id}/explain",
        json={"user_id": "priya", "at_ms": at, "pending_results": pending},
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
    client: AsyncClient, sample: LoadedFixture, fake_llm: llm.FakeLLM
) -> None:
    gid = sample.group_id("volleyball")
    call_id = (await _join(client, gid, "jordan"))["call"]["id"]
    await _join(client, gid, "priya")
    pending = [result("p", "jordan", "bro you're getting procs", now_ms() - 3000)]
    fake_llm.queue({"term": "procs", "meaning": "?", "kind": "unknown", "said_in": 1})
    out = (
        await client.post(
            f"{URL}/calls/{call_id}/explain",
            json={"user_id": "priya", "at_ms": now_ms(), "pending_results": pending},
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
