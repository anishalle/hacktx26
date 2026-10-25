"""Invariants of the generated demo fixture (backend/app/seed/fixtures/demo.json)."""

import re
from datetime import timedelta

from conftest import LoadFixture, read_fixture
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud
from app.models import Glossary, Membership, Message
from app.seed import anchored_now
from app.services.nudge import is_common

PLANTED = {
    "Grandma's": ["grandma's", "grandmas", "grandma"],
    "usual spot": ["usual spot"],
    "the Incident": ["incident"],
    "procs": ["procs", "proc", "procced", "proccing", "procd"],
    "Torchy's Tuesday": ["torchy's tuesday", "torchys tuesday", "torchy tuesday"],
}
UNEXPLAINED = ["brayden", "braydens"]  # "pull a Brayden": used, never explained


def mentions(text: str, names: list[str]) -> bool:
    t = text.lower().replace("’", "'")
    alts = "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True))
    return bool(re.search(rf"(?<![a-z0-9])(?:{alts})(?![a-z0-9])", t))


async def test_demo_fixture_invariants(
    load_fixture: LoadFixture, session: AsyncSession
) -> None:
    data = read_fixture("demo.json")
    fx = await load_fixture(data)
    if "anchor" in data:
        # loaded at the anchor's latest weekly occurrence, so weekday words stay true
        assert fx.now == anchored_now(data["anchor"], fx.now)
    gid = fx.group_id("volleyball")
    msgs = list(
        await session.scalars(
            select(Message).where(Message.group_id == gid).order_by(Message.id)
        )
    )
    assert 1800 <= len(msgs) <= 2400
    assert all(a.ts < b.ts for a, b in zip(msgs, msgs[1:], strict=False))

    priya = await session.get(Membership, (gid, "priya"))
    assert priya is not None and priya.last_read_message_id is None
    assert priya.joined_at == fx.now - timedelta(days=2)
    join = next(m for m in msgs if m.kind == "system")
    assert join.text == "aakash added priya.k" and join.ts == priya.joined_at
    pre = [m for m in msgs if m.ts < priya.joined_at]
    post = [m for m in msgs if m.ts > priya.joined_at]
    assert 600 <= len(pre) <= 900 and 1100 <= len(post) <= 1450
    assert not any(m.sender_id == "priya" for m in msgs)
    assert await crud.count_unread(session, priya) == len(post) + 1
    last_day = [m for m in post if m.ts > fx.now - timedelta(hours=30)]
    assert len(last_day) > 0.75 * len(post)

    others = [m for m in await crud.list_memberships(session, gid) if m != priya]
    assert len(others) == 12
    assert all(m.last_read_message_id is not None for m in others)

    rows = {
        g.term: g
        for g in await session.scalars(select(Glossary).where(Glossary.group_id == gid))
    }
    assert set(rows) == set(PLANTED)
    by_id = {m.id: m for m in msgs}
    for term, names in PLANTED.items():
        row = rows[term]
        assert row.source == "seed"
        assert row.last_explained_ts is not None
        assert row.first_seen_ts <= row.last_explained_ts < priya.joined_at
        first = next(m for m in msgs if m.ts == row.first_seen_ts)
        explained = next(m for m in msgs if m.ts == row.last_explained_ts)
        assert mentions(first.text, names) and mentions(explained.text, names)
        assert all(not mentions(m.text, names) for m in msgs if m.id < first.id)
        assert row.source_message_ids and all(
            i in by_id for i in row.source_message_ids
        )
        assert sum(mentions(m.text, names) for m in post) >= 3, term

    brayden = [m for m in msgs if mentions(m.text, UNEXPLAINED)]
    assert sum(m.ts > priya.joined_at for m in brayden) >= 3
    assert not any("brayden" in t.lower() for t in rows)
    # the unknown-term nudge only asks the LLM about words outside the dictionary
    assert not is_common("brayden")

    reacted = await session.scalar(
        select(Message.id)
        .where(Message.group_id == gid, Message.reactions.any())
        .limit(1)
    )
    assert reacted is not None


async def test_demo_inbox_mix(load_fixture: LoadFixture, session: AsyncSession) -> None:
    fx = await load_fixture(read_fixture("demo.json"))
    for user in ("priya", "swayam"):
        ms = [
            m
            for m in await session.scalars(
                select(Membership).where(Membership.user_id == user)
            )
            if m.group_id != fx.group_id("volleyball")
        ]
        unread = [await crud.count_unread(session, m) for m in ms]
        assert len(ms) >= 3, user
        assert any(unread) and not all(unread), (user, unread)
