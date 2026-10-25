import array
import asyncio
import io
import re
import wave
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import db
from app.core.config import settings
from app.models import Glossary, Lore, LoreReplay, Message, Reaction
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
    assert "story" not in feed["items"][0]  # the title is the only AI text served
    gid = sample.group_id("dm_maya_jordan")
    assert (await client.get(f"{URL}/users/maya/lore?group_id={gid}")).json() == {
        "items": [],
        "next_cursor": None,
        "counts": {"photo": 0, "replay": 0, "quote": 0, "pinned": 0},
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


# --------------------------------------------------------------------- events

T0 = datetime(2026, 10, 1, 20, 0, tzinfo=UTC)


def line(
    id: int,
    sender: str,
    text: str = "",
    *,
    at: float = 0.0,  # minutes after T0
    kind: str = "text",
    reply_to: int | None = None,
    reactions: int = 0,
) -> Message:
    m = Message(
        id=id,
        group_id=1,
        sender_id=sender,
        kind=kind,
        text=text,
        ts=T0 + timedelta(minutes=at),
        reply_to=reply_to,
    )
    m.reactions = [
        Reaction(message_id=id, user_id=f"u{i}", emoji="😂") for i in range(reactions)
    ]
    return m


def test_events_photo_snippets_score_dedupe_and_order() -> None:
    p1 = line(100, "a", kind="photo", reactions=1)  # no caption
    p2 = line(110, "b", "round two", at=5, kind="photo", reactions=2)
    pool = [
        p1,
        p2,
        line(101, "b", "LMAO 😭", at=1, reactions=2),
        line(102, "b", "dead", at=1),
        line(103, "b", "ok", at=2),  # logistics
        line(104, "c", "no way he did that", at=2),
        line(105, "b", "this is the best one lol", at=3, reactions=1),
        line(106, "a", "i know right", at=3),  # the author, nothing else
        line(111, "d", "wait who took this", at=6, reply_to=100),  # replies to p1
        line(112, "c", "lmaooo", at=6),
        line(113, "b", "same angle again", at=6),  # p2's author
        line(114, "e", "where are you guys", at=7),
        line(115, "c", "much later", at=25),  # > 15 min after p2
    ]
    events, hero = lore._events(pool, [100, 110])
    assert events == [
        # b's best two only (102 loses to the cap); 111 joins p1 although p2 is
        # nearer, because it replies to p1; oldest first
        {"kind": "photo", "message_id": 100, "snippet_ids": [101, 104, 105, 111]},
        {"kind": "photo", "message_id": 110, "snippet_ids": [112]},
    ]
    assert hero == 110  # the most-reacted photo
    assert lore._events(pool, [100, 110], hero_hints=[100])[1] == 100  # Muse's pick
    assert lore._events(pool, [100, 110], hero_hints=[104])[1] == 110  # not a photo

    # the caption takes a slot and counts toward its sender
    with_caption = [line(100, "a", "look", kind="photo"), *pool[2:8]]
    events, _ = lore._events(with_caption, [100])
    assert events[0]["snippet_ids"] == [101, 104, 105]


def test_events_replay_spoken_turns_and_chat_after() -> None:
    captions = [
        ("a", 0, 3_000, "so anyway"),  # long before the signal (26 s)
        ("a", 18_500, 20_000, "he walks in"),
        ("a", 20_000, 21_500, "with the ramen"),  # same turn as the line above
        ("b", 22_000, 24_000, "no way"),
        ("c", 24_000, 26_000, "stop"),
        ("b", 26_000, 28_000, "im crying"),
    ]
    replay = LoreReplay(
        id=7,
        call_id=1,
        group_id=1,
        audio_path="x.wav",
        duration_ms=30_000,
        started_at=T0,
        signal="phrase",
        captions=[
            {"user_id": u, "start_ms": s, "end_ms": e, "text": t}
            for u, s, e, t in captions
        ],
    )
    pool = [
        line(301, "b", "LMAO that call 😭", at=1.5, reactions=2),
        line(302, "c", "ok", at=2),
        line(303, "d", "dead 💀", at=2, reactions=1),  # scores under 2
        line(304, "a", "lol", at=12),  # more than 10 min after
    ]
    events, hero = lore._events(pool, [], [replay])
    # four turns overlap [18 s, 30 s]; the three nearest the signal, oldest first
    assert events == [
        {
            "kind": "replay",
            "replay_id": 7,
            "caption_idx": [3, 4, 5],
            "snippet_ids": [301],
        }
    ]
    assert hero is None


def test_events_quote_when_nothing_to_show() -> None:
    pool = [
        line(201, "a", "GRANDMA'S HOUSE IS OPEN", reactions=1),
        line(202, "b", "why do you call it grandma's", at=1, reactions=3),
        line(203, "a", "plastic on the couches", at=2, reply_to=202),
        line(204, "c", "it's canon", at=3),
        line(205, "d", "ok", at=4),
        line(206, "e", "i'm stealing this", at=5, reply_to=202),  # a reply, not key
    ]
    events, hero = lore._events(pool, [201, 202, 203, 204, 205], terms=["Grandma"])
    assert events == [
        {"kind": "quote", "message_id": 202, "snippet_ids": [201, 203, 204, 206]}
    ]
    assert hero == 202


async def test_photo_moment_events_through_backfill_and_api(
    client: AsyncClient,
    session: AsyncSession,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    gid = sample.group_id("volleyball")

    def add(sender: str, text: str, kind: str = "text", **kw: Any) -> Message:
        m = Message(group_id=gid, sender_id=sender, kind=kind, text=text, **kw)
        session.add(m)
        return m

    photo = {"image_path": "0" * 32 + ".jpg", "image_width": 4, "image_height": 3}
    first = add("maya", "the ramen", "photo", **photo)
    await session.flush()
    add("jordan", "MIKE NOT AGAIN 😭")
    second = add("leo", "", "photo", **photo)
    await session.flush()
    add("aakash", "framing this one")
    await session.commit()
    jordan = first.id + 1
    fake_llm.handler = lambda call: {
        "moments": [
            {
                "title": "Mike sets off the ramen alarm again",
                "story": "Mike set off the alarm making ramen.",
                "start_message_id": first.id,
                "end_message_id": second.id + 1,
                "key_message_ids": [first.id, jordan],  # left the hero out
                "hero_message_id": second.id,
                "score": 0.55,  # under KEEP_SCORE, but media counts extra
            }
        ]
    }
    [row] = await lore.backfill_group(session, gid)
    assert {first.id, second.id} <= set(row.message_ids)
    assert row.hero_message_id == second.id
    assert [e["kind"] for e in row.events] == ["photo", "photo"]

    item = (await client.get(f"{URL}/users/jordan/lore")).json()["items"][0]
    assert item["hero_kind"] == "photo"
    hero, other = item["events"]
    assert hero["message"]["id"] == item["cover"]["photo"]["id"] == second.id
    assert other["message"]["id"] == first.id
    first_lines = [(s["reason"], s["text"], s["is_me"]) for s in other["snippets"]]
    assert first_lines == [
        ("caption", "the ramen", False),
        ("key", "MIKE NOT AGAIN 😭", True),
    ]
    assert [s["text"] for s in hero["snippets"]] == ["framing this one"]
    assert [m["id"] for m in item["media"]] == [first.id, second.id]
    assert item["cover"]["replay"] is None and item["pinned"] is False


async def test_text_moment_is_a_quote_and_startup_fills_events(
    client: AsyncClient,
    session: AsyncSession,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    [kept] = await _backfill(
        session,
        sample,
        fake_llm,
        [moment(sample, "Swayam's house becomes Grandma", [10, 12, 13])],
    )
    canon = sample.msg("volleyball", 13)  # three 😂, the most reacted
    assert kept.events == [
        {
            "kind": "quote",
            "message_id": canon,
            "snippet_ids": [sample.msg("volleyball", 10), sample.msg("volleyball", 12)],
        }
    ]
    assert kept.hero_message_id == canon

    item = (await client.get(f"{URL}/users/jordan/lore")).json()["items"][0]
    assert item["hero_kind"] == "quote" and item["cover"] == {
        "photo": None,
        "replay": None,
    }
    [event] = item["events"]
    assert (
        event["message"]["text"]
        == "ok from now on swayam's house = Grandma. it's canon"
    )
    assert [(s["user"]["id"], s["is_me"]) for s in event["snippets"]] == [
        ("jordan", True),
        ("jordan", True),
    ]
    assert len(event["message"]["reactions"]) == 3

    # rows from before events existed get them at startup, once
    gid = sample.group_id("volleyball")
    old = Lore(
        group_id=gid,
        title="old",
        story="s",
        status="kept",
        started_at=sample.now,
        ended_at=sample.now,
        message_ids=[sample.msg("volleyball", 6), sample.msg("volleyball", 7)],
    )
    session.add(old)
    await session.commit()
    await db.init_db()
    await session.refresh(old)
    assert old.events and old.events[0]["kind"] == "quote"
    assert await lore.backfill_events(session) == 0


# ------------------------------------------------------------ pins and filters


def _row(gid: int, title: str, kind: str, score: float, days: float, **kw: Any):
    ended = datetime.now(UTC) - timedelta(days=days)
    return Lore(
        group_id=gid,
        title=title,
        story="s",
        status=kw.pop("status", "kept"),
        source="chat",
        started_at=ended,
        ended_at=ended,
        score=score,
        events=[{"kind": kind, "snippet_ids": []}],
        **kw,
    )


async def test_pins_are_per_member(
    client: AsyncClient,
    session: AsyncSession,
    ws_connect: WsConnect,
    sample: LoadedFixture,
) -> None:
    gid = sample.group_id("volleyball")
    a = _row(gid, "a", "quote", 0.5, 1)
    b = _row(gid, "b", "quote", 0.5, 1, status="suggested")
    session.add_all([a, b])
    await session.commit()

    async with ws_connect("priya") as priya, ws_connect("maya") as maya:
        resp = await client.post(f"{URL}/lore/{a.id}/pin", json={"user_id": "priya"})
        assert resp.status_code == 200 and resp.json()["pinned"] is True
        frame = await priya.receive_json(timeout=2)
        assert (frame["type"], frame["data"]["pinned"]) == ("lore.updated", True)
        # a group-wide update: the pin shows only for priya
        await lore.announce(session, a)
        assert (await priya.receive_json(timeout=2))["data"]["pinned"] is True
        frame = await maya.receive_json(timeout=2)  # nothing came before this one
        assert (frame["data"]["id"], frame["data"]["pinned"]) == (a.id, False)

    again = await client.post(f"{URL}/lore/{a.id}/pin", json={"user_id": "priya"})
    assert again.json()["pinned"] is True  # idempotent
    feed = (await client.get(f"{URL}/users/priya/lore?pinned=true")).json()
    assert [i["title"] for i in feed["items"]] == ["a"]
    assert feed["counts"]["pinned"] == 1 and feed["items"][0]["pinned"] is True
    maya_feed = (await client.get(f"{URL}/users/maya/lore")).json()
    assert maya_feed["counts"]["pinned"] == 0 and not maya_feed["items"][0]["pinned"]
    detail = (await client.get(f"{URL}/lore/{a.id}?user_id=priya")).json()
    assert detail["pinned"] is True

    resp = await client.post(f"{URL}/lore/{b.id}/pin", json={"user_id": "priya"})
    assert resp.status_code == 409  # only kept lore
    resp = await client.post(f"{URL}/lore/{a.id}/pin", json={"user_id": "nobody"})
    assert resp.status_code in (403, 404)

    resp = await client.delete(f"{URL}/lore/{a.id}/pin?user_id=priya")
    assert resp.status_code == 200 and resp.json()["pinned"] is False
    feed = (await client.get(f"{URL}/users/priya/lore?pinned=true")).json()
    assert feed["items"] == [] and feed["counts"]["pinned"] == 0


async def test_feed_filters_sort_and_counts(
    client: AsyncClient, session: AsyncSession, sample: LoadedFixture
) -> None:
    gid = sample.group_id("volleyball")
    rows = {
        r.title: r
        for r in [
            _row(gid, "Photo night", "photo", 0.5, 1),
            _row(gid, "Call replay", "replay", 0.9, 30),
            _row(gid, "Big quote", "quote", 0.95, 0),
            _row(gid, "Tacos at Grandma's", "quote", 0.2, 2),
        ]
    }
    session.add_all(rows.values())
    await session.commit()

    async def titles(query: str, user: str = "priya") -> list[str]:
        resp = await client.get(f"{URL}/users/{user}/lore?{query}")
        assert resp.status_code == 200, resp.text
        return [i["title"] for i in resp.json()["items"]]

    assert await titles("kind=photo") == ["Photo night"]
    assert await titles("kind=replay") == ["Call replay"]
    assert await titles("kind=quote") == ["Big quote", "Tacos at Grandma's"]
    assert await titles("q=grandma") == ["Tacos at Grandma's"]
    assert await titles("q=100%") == []  # LIKE wildcards are literal
    counts = (await client.get(f"{URL}/users/priya/lore?kind=photo")).json()["counts"]
    assert counts == {"photo": 1, "replay": 1, "quote": 2, "pinned": 0}
    counts = (await client.get(f"{URL}/users/priya/lore?q=tacos")).json()["counts"]
    assert counts == {"photo": 0, "replay": 0, "quote": 1, "pinned": 0}
    assert (await client.get(f"{URL}/users/priya/lore?kind=video")).status_code == 422

    # 0.6·score (+0.1 with media) + 0.25·recency + 0.15·media
    assert await titles("sort=deck") == [
        "Big quote",  # .57 + .25
        "Call replay",  # .6 + .06 + .12
        "Photo night",  # .36 + .24 + .15
        "Tacos at Grandma's",  # .12 + .23
    ]
    tacos = rows["Tacos at Grandma's"]
    await client.post(f"{URL}/lore/{tacos.id}/pin", json={"user_id": "priya"})
    page = (await client.get(f"{URL}/users/priya/lore?sort=deck&limit=2")).json()
    assert [i["title"] for i in page["items"]] == ["Tacos at Grandma's", "Big quote"]
    rest = (
        await client.get(
            f"{URL}/users/priya/lore?sort=deck&limit=2&cursor={page['next_cursor']}"
        )
    ).json()
    assert [i["title"] for i in rest["items"]] == ["Call replay", "Photo night"]
    assert rest["next_cursor"] is None
    assert (await titles("sort=deck", "maya"))[0] == "Big quote"  # priya's pin
    resp = await client.get(f"{URL}/users/priya/lore?sort=deck&cursor=deck:x")
    assert resp.status_code == 422


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
    assert data["hero_kind"] == "replay" and data["events"][0]["replay"] == replay
    spoken = data["events"][0]["snippets"][0]
    assert (spoken["reason"], spoken["user"]["id"], spoken["message_id"]) == (
        "spoken",
        "jordan",
        None,
    )
    assert spoken["text"] == "no way mike did it again" and spoken["start_ms"] >= 0
    assert replay["audio_url"].endswith(".wav")
    served = await client.get(replay["audio_url"].removeprefix(settings.PUBLIC_URL))
    assert (served.status_code, served.headers["content-type"]) == (200, "audio/wav")

    resp = await client.post(f"{URL}/lore/{data['id']}/keep", json={"user_id": "priya"})
    assert resp.json()["status"] == "kept"
    assert (await session.scalars(select(LoreReplay))).one().signal == "phrase"
