import array
import asyncio
import io
import re
import wave
from collections.abc import Iterator
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models import Glossary, Lore, LoreReplay
from app.seed import LoadedFixture
from app.services import embeddings, llm, lore, nudge, replays
from tests.conftest import WsConnect
from tests.test_calls import _join, _mic

URL = "/api/v1"


@pytest.fixture(autouse=True)
def _env(tmp_path, monkeypatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "MEDIA_DIR", tmp_path)
    monkeypatch.setattr(replays, "SETTLE_S", 0)
    nudge.invalidate_glossary()  # group ids repeat across tests (RESTART IDENTITY)
    yield
    nudge.invalidate_glossary()


def moment(
    sample: LoadedFixture, title: str, idxs: list[int], score: float = 0.9, **kw: Any
) -> dict[str, Any]:
    ids = [sample.msg("volleyball", i) for i in idxs]
    return {
        "title": title,
        "story": kw.get("story", f"The story of {title}."),
        "start_message_id": ids[0],
        "end_message_id": ids[-1],
        "key_message_ids": ids,
        "terms": kw.get("terms", []),
        "score": score,
    }


async def _backfill(
    session: AsyncSession, sample: LoadedFixture, fake_llm: llm.FakeLLM, moments
) -> list[Lore]:
    fake_llm.handler = lambda call: {"moments": moments}
    return await lore.backfill_group(session, sample.group_id("volleyball"))


# ------------------------------------------------------------------- backfill


async def test_backfill_keeps_strong_moments_and_merges_twins(
    session: AsyncSession, sample: LoadedFixture, fake_llm: llm.FakeLLM
) -> None:
    kept = await _backfill(
        session,
        sample,
        fake_llm,
        [
            moment(sample, "Swayam's house becomes Grandma's", [10, 11, 12, 13]),
            moment(sample, "Swayam's house becomes Grandma's", [15, 16]),  # twin
            moment(sample, "The usual spot", [5, 6, 7], score=0.7),
            moment(sample, "Someone is late", [21], score=0.2),  # not memorable
            {"title": "Made up", "story": "x", "key_message_ids": [999999]},
        ],
    )
    assert [k.title for k in kept] == [
        "Swayam's house becomes Grandma's",
        "The usual spot",
    ]
    grandma = kept[0]
    assert grandma.status == "kept" and grandma.kept_by is None
    assert sample.msg("volleyball", 16) in grandma.message_ids  # twin merged in
    assert {"jordan", "aakash", "maya"} <= set(grandma.people)
    assert "Grandma" in grandma.terms  # found in its messages via the glossary
    assert grandma.embedding is not None
    assert grandma.started_at <= grandma.ended_at
    # the detector saw raw lines with ids
    assert re.search(r"\[#\d+ \d\d:\d\d ", fake_llm.calls[0].user)

    again = await _backfill(
        session,
        sample,
        fake_llm,
        [moment(sample, "Swayam's house becomes Grandma's", [10, 13])],
    )
    rows = (await session.scalars(select(Lore))).all()
    assert len(rows) == 2  # merged into the existing lore, not duplicated
    assert again[0].id == grandma.id


# -------------------------------------------------------------- feed + views


async def test_feed_detail_and_related(
    client: AsyncClient,
    session: AsyncSession,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    kept = await _backfill(
        session,
        sample,
        fake_llm,
        [
            moment(sample, "Grandma's is born", [10, 12, 13], terms=["Grandma"]),
            moment(sample, "The usual spot", [5, 6, 7], score=0.8),
            moment(sample, "League signups", [31, 32, 33, 34], score=0.7),
        ],
    )
    feed = (await client.get(f"{URL}/users/priya/lore?limit=2")).json()
    assert len(feed["items"]) == 2 and feed["next_cursor"]
    rest = (
        await client.get(f"{URL}/users/priya/lore?limit=2&cursor={feed['next_cursor']}")
    ).json()
    titles = [i["title"] for i in feed["items"] + rest["items"]]
    assert titles == ["League signups", "Grandma's is born", "The usual spot"]
    assert rest["next_cursor"] is None
    # not in the group, no lore
    assert (await client.get(f"{URL}/users/nina/lore")).json()["items"]
    gid = sample.group_id("dm_maya_jordan")
    assert (await client.get(f"{URL}/users/maya/lore?group_id={gid}")).json() == {
        "items": [],
        "next_cursor": None,
    }

    grandma = next(k for k in kept if k.title == "Grandma's is born")
    resp = await client.get(f"{URL}/lore/{grandma.id}?user_id=priya")
    assert resp.status_code == 200, resp.text
    d = resp.json()
    assert [m["id"] for m in d["messages"]] == sorted(grandma.message_ids)
    assert {t["term"]: bool(t["glossary_id"]) for t in d["terms"]}["Grandma"] is True
    assert {p["id"] for p in d["people"]} >= {"jordan", "aakash"}
    assert d["group_name"] == "Thursday Volleyball 🏐"
    assert len(d["related"]) == 2 and d["id"] not in [r["id"] for r in d["related"]]
    gid = sample.group_id("dm_maya_jordan")
    assert (
        await client.get(f"{URL}/lore/{grandma.id}?user_id=maya")
    ).status_code == 200
    resp = await client.get(f"{URL}/lore/{grandma.id}?user_id=nobody")
    assert resp.status_code in (403, 404)


async def test_keep_dismiss_remove(
    client: AsyncClient,
    session: AsyncSession,
    ws_connect: WsConnect,
    sample: LoadedFixture,
) -> None:
    gid = sample.group_id("volleyball")
    rows = [
        Lore(
            group_id=gid,
            title=t,
            story="s",
            status="suggested",
            source="chat",
            started_at=sample.now,
            ended_at=sample.now,
            message_ids=[sample.msg("volleyball", 13)],
            anchor_message_id=sample.msg("volleyball", 13),
        )
        for t in ("a", "b")
    ]
    session.add_all(rows)
    await session.commit()
    a, b = rows

    suggested = (
        await client.get(f"{URL}/groups/{gid}/lore/suggestions?user_id=priya")
    ).json()
    assert [s["title"] for s in suggested] == ["a", "b"]
    assert suggested[0]["anchor_message_id"] == sample.msg("volleyball", 13)

    async with ws_connect("maya") as maya:
        resp = await client.post(f"{URL}/lore/{a.id}/keep", json={"user_id": "priya"})
        assert resp.json()["status"] == "kept"
        assert resp.json()["kept_by"]["id"] == "priya"
        frame = await maya.receive_json(timeout=2)
        assert (frame["type"], frame["data"]["status"]) == ("lore.updated", "kept")
    again = await client.post(f"{URL}/lore/{a.id}/keep", json={"user_id": "maya"})
    assert again.json()["kept_by"]["id"] == "priya"  # first tap wins

    await client.post(f"{URL}/lore/{b.id}/dismiss", json={"user_id": "maya"})
    resp = await client.post(f"{URL}/lore/{b.id}/keep", json={"user_id": "priya"})
    assert resp.status_code == 409
    assert (
        await client.get(f"{URL}/groups/{gid}/lore/suggestions?user_id=priya")
    ).json() == []

    resp = await client.post(f"{URL}/lore/{a.id}/remove", json={"user_id": "sam"})
    assert resp.json()["status"] == "removed"  # any member can remove
    assert (await client.get(f"{URL}/users/priya/lore")).json()["items"] == []


async def test_simultaneous_keeps_fold_a_replay_once(
    client: AsyncClient, session: AsyncSession, sample: LoadedFixture
) -> None:
    gid = sample.group_id("volleyball")
    call_id = (await _join(client, gid, "jordan"))["call"]["id"]
    replay = LoreReplay(
        call_id=call_id,
        group_id=gid,
        audio_path="0" * 32 + ".wav",
        duration_ms=30000,
        started_at=sample.now,
        signal="phrase",
    )
    session.add(replay)
    await session.flush()
    vector = await embeddings.embed("Kobe serve flies into the bleachers")
    common = {
        "group_id": gid,
        "story": "Kobe's serve went into the bleachers.",
        "started_at": sample.now,
        "ended_at": sample.now,
        "terms": ["serve"],
        "embedding": vector,
    }
    target = Lore(title="Kobe's serve", status="kept", source="chat", **common)
    suggested = Lore(
        title="The serve again",
        status="suggested",
        source="call",
        call_id=call_id,
        replay_ids=[replay.id],
        **common,
    )
    session.add_all([target, suggested])
    await session.commit()

    taps = await asyncio.gather(
        *(
            client.post(f"{URL}/lore/{suggested.id}/keep", json={"user_id": u})
            for u in ("priya", "maya")
        )
    )
    assert [t.status_code for t in taps] == [200, 200]
    assert {t.json()["id"] for t in taps} == {target.id}
    await session.refresh(target)
    assert target.replay_ids == [replay.id]


# ------------------------------------------------------------- live detection


async def test_live_detection_suggests_once_triggered(
    client: AsyncClient,
    session: AsyncSession,
    ws_connect: WsConnect,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gid = sample.group_id("volleyball")
    monkeypatch.setattr(lore, "BURST_MESSAGES", 2)
    assert await lore.detect_recent(session, gid) is None  # first look: no rescan
    assert fake_llm.calls == []

    sent = []
    for text in ("MIKE SET OFF THE ALARM AGAIN", "everyone outside in pajamas 💀"):
        resp = await client.post(
            f"{URL}/groups/{gid}/messages", json={"sender_id": "jordan", "text": text}
        )
        sent.append(resp.json()["id"])
    await lore.drain()  # sending schedules detection; let it run with the handler

    def detect(call: llm.LLMCall) -> dict[str, Any]:
        assert "MIKE SET OFF THE ALARM AGAIN" in call.user
        return {
            "moments": [
                {
                    "title": "The fire alarm, again",
                    "story": "Mike set off the alarm and everyone ended up outside.",
                    "start_message_id": sent[0],
                    "end_message_id": sent[1],
                    "key_message_ids": sent,
                    "terms": [],
                    "score": 0.85,
                }
            ]
        }

    fake_llm.handler = detect
    lore.reset()
    session.add(  # an earlier moment, so the scan starts from its anchor
        Lore(
            group_id=gid,
            title="old",
            story="s",
            status="dismissed",
            started_at=sample.now,
            ended_at=sample.now,
            anchor_message_id=sent[0] - 1,
        )
    )
    await session.commit()
    async with ws_connect("maya") as maya:
        row = await lore.detect_recent(session, gid)
        frame = await maya.receive_json(timeout=2)
    assert row is not None and row.status == "suggested"
    assert row.anchor_message_id == sent[1] and set(sent) <= set(row.message_ids)
    assert (frame["type"], frame["data"]["title"]) == (
        "lore.updated",
        "The fire alarm, again",
    )
    assert await lore.detect_recent(session, gid) is None  # nothing new since


async def test_explanations_link_their_lore(
    client: AsyncClient,
    session: AsyncSession,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    await _backfill(
        session,
        sample,
        fake_llm,
        [moment(sample, "Grandma's is born", [10, 12, 13], terms=["Grandma"])],
    )
    fake_llm.handler = None
    fake_llm.queue(
        {
            "term": "Grandma",
            "meaning": "**Grandma** is Swayam's house.",
            "kind": "nickname",
            "confidence": 0.9,
            "source_message_ids": [sample.msg("volleyball", 13)],
        }
    )
    out = (
        await client.post(
            f"{URL}/explain",
            json={
                "group_id": sample.group_id("volleyball"),
                "user_id": "priya",
                "message_id": sample.msg("volleyball", 36),
            },
        )
    ).json()
    assert [entry["title"] for entry in out["lore"]] == ["Grandma's is born"]


async def test_explanation_lore_ranks_term_then_pressed_then_sources(
    client: AsyncClient,
    session: AsyncSession,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    await _backfill(
        session,
        sample,
        fake_llm,
        [
            moment(sample, "Mike's alarm night", [10, 12, 13], score=0.95),
            moment(sample, "Birth of procs", [20, 21], score=0.7, terms=["procs"]),
            moment(sample, "Tuesday tacos plan", [34, 36], score=0.8),
        ],
    )
    fake_llm.handler = None
    fake_llm.queue(
        {
            "term": "procs",
            "meaning": "**procs** are roasts back to back.",
            "kind": "slang",
            "confidence": 0.9,
            "source_message_ids": [sample.msg("volleyball", 13)],
        }
    )
    out = (
        await client.post(
            f"{URL}/explain",
            json={
                "group_id": sample.group_id("volleyball"),
                "user_id": "priya",
                "message_id": sample.msg("volleyball", 36),
            },
        )
    ).json()
    assert [entry["title"] for entry in out["lore"]] == [
        "Birth of procs",
        "Tuesday tacos plan",
    ]


async def test_explanation_lore_prefers_term_in_title_then_primary(
    session: AsyncSession, sample: LoadedFixture
) -> None:
    gid = sample.group_id("volleyball")
    pressed = sample.msg("volleyball", 36)
    session.add(
        Glossary(
            group_id=gid, term="zorbs", aliases=["zorb"], meaning="m", kind="slang"
        )
    )

    def row(title: str, terms: list[str], score: float, ids: list[int] = []) -> Lore:
        return Lore(
            group_id=gid,
            title=title,
            story="s",
            status="kept",
            source="chat",
            started_at=sample.now,
            ended_at=sample.now,
            terms=terms,
            message_ids=ids,
            score=score,
        )

    session.add_all(
        [
            # The reported case: a merged entry picked "zorbs" up as a side term.
            row("The Incident", ["the Incident", "zorbs", "jester boy"], 0.95),
            row("Pookie hour", ["zorbs"], 0.9),
            row("Late night", ["jester boy"], 0.3),
            row("Mike Collects Zorbs Like Stones", [], 0.6, [pressed]),
            row("The Birth of Zorb", ["zorb", "proc farm"], 0.5),
            row("Unrelated pressed", [], 0.99, [pressed]),
        ]
    )
    await session.commit()
    nudge.invalidate_glossary()

    async def titles(term: str | None, pressed_id: int | None = None) -> list[str]:
        out = await lore.for_explanation(session, gid, term, pressed_id, [])
        return [entry.title for entry in out]

    # Term (or its alias) in the title first, primary term breaking the tie.
    assert await titles("ZORBS", pressed) == [
        "The Birth of Zorb",
        "Mike Collects Zorbs Like Stones",
    ]
    # Without title matches: primary term beats a side term with a higher score.
    assert await titles("jester boy") == ["Late night", "The Incident"]


# ------------------------------------------------------------------- replays


def pcm(level: int, ms: int = 80) -> bytes:
    return array.array("h", [level] * (24 * ms)).tobytes()


async def test_replay_signals_and_clip() -> None:
    m = replays.CallMoments(call_id=1, group_id=1, keywords=["Grandma"])
    fired: list[str] = []
    m.signal = lambda kind, at_ms=None: fired.append(kind)  # type: ignore[method-assign]

    for t in range(0, 2000, 80):  # one person talking at a steady level
        m.add_audio("a", pcm(1500), 10_000 + t)
    assert fired == []
    m.add_audio("b", pcm(1500), 12_000)
    m.add_audio("c", pcm(1500), 12_100)
    assert fired[-1] == "overlap"  # three people at once

    fired.clear()
    loud = replays.CallMoments(call_id=2, group_id=1)
    loud.signal = lambda kind, at_ms=None: fired.append(kind)  # type: ignore[method-assign]
    for t in range(0, 2000, 80):
        loud.add_audio("a", pcm(1500), t)
    for t in range(2000, 2600, 80):  # laughter: much louder for a while
        loud.add_audio("a", pcm(20000), t)
    assert set(fired) == {"loud"}  # (the real signal() debounces repeats)

    fired.clear()
    m.add_turn("a", "wait we're going to grandma's later", 20_000, 21_000)
    m.add_turn("b", "no way he did that", 21_000, 22_000)
    assert fired == ["term", "phrase"]

    wav, start, captions = m.clip(25_000)
    with wave.open(io.BytesIO(wav)) as w:
        assert (w.getframerate(), w.getnchannels()) == (24_000, 1)
        assert w.getnframes() == 24_000 * 30
    assert start == -5_000
    assert captions[-1] == {
        "user_id": "b",
        "text": "no way he did that",
        "start_ms": 26_000,
        "end_ms": 27_000,
    }


async def test_debounce_one_moment_one_signal() -> None:
    m = replays.CallMoments(call_id=3, group_id=1)
    m.signal("phrase", 1_000)
    first = m.task
    m.signal("phrase", 2_000)  # same moment: ignored
    assert m.task is first
    first.cancel()


async def test_call_phrase_becomes_a_replay_suggestion(
    client: AsyncClient,
    session: AsyncSession,
    ws_connect: WsConnect,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    gid = sample.group_id("volleyball")
    call_id = (await _join(client, gid, "jordan"))["call"]["id"]
    await _join(client, gid, "priya")

    def title(call: llm.LLMCall) -> dict[str, Any]:
        assert "Jordan Lee: no way mike did it again" in call.user
        return {
            "keep": True,
            "title": "Mike did it again",
            "story": "Jordan can't believe Mike set off the alarm again.",
            "terms": [],
        }

    fake_llm.handler = title
    async with ws_connect("priya") as priya, _mic(call_id, "jordan") as mic:
        assert await mic.receive_json(timeout=2) == {"type": "ready"}
        await mic.send_bytes(b"no way mike did it again")
        await mic.send_bytes(b"")
        while True:
            frame = await priya.receive_json(timeout=3)
            if frame["type"] == "lore.updated":
                break
    data = frame["data"]
    assert (data["source"], data["status"], data["call_id"]) == (
        "call",
        "suggested",
        call_id,
    )
    replay = data["cover"]["replay"]
    assert replay["captions"][0]["user_id"] == "jordan"
    assert replay["audio_url"].endswith(".wav")
    served = await client.get(replay["audio_url"].removeprefix(settings.PUBLIC_URL))
    assert (served.status_code, served.headers["content-type"]) == (200, "audio/wav")

    resp = await client.post(f"{URL}/lore/{data['id']}/keep", json={"user_id": "priya"})
    assert resp.json()["status"] == "kept"
    assert (await session.scalars(select(LoreReplay))).one().signal == "phrase"
