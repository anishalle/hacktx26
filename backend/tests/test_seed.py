import hashlib
import json
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from conftest import LoadFixture
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.core.config import settings
from app.models import Lore, LoreGame, Membership, Message, User
from app.seed import FIXTURES_DIR, MEDIA_SRC, LoadedFixture, copy_all_media
from app.services import games, llm, lore


async def test_sample_offsets_are_relative(
    session: AsyncSession, sample: LoadedFixture
) -> None:
    gid = sample.group_id("volleyball")
    priya = await session.get(Membership, (gid, "priya"))
    assert priya is not None
    assert priya.joined_at == sample.now - timedelta(days=2)
    ts = list(
        await session.scalars(
            select(Message.ts).where(Message.group_id == gid).order_by(Message.id)
        )
    )
    assert ts == sorted(ts) and len(ts) == 62


async def test_load_inline_fixture(
    load_fixture: LoadFixture, session: AsyncSession
) -> None:
    fx = await load_fixture(
        {
            "users": [
                {"id": "a", "username": "a", "display_name": "A"},
                {"id": "b", "username": "b", "display_name": "B"},
            ],
            "groups": [
                {
                    "key": "g",
                    "name": "G",
                    "members": [
                        {"user_id": "a", "joined_offset_s": 100, "last_read_idx": 1},
                        {"user_id": "b", "joined_offset_s": 10, "last_read_idx": None},
                    ],
                    "messages": [
                        {
                            "idx": 1,
                            "sender_id": "b",
                            "text": "second",
                            "offset_s": 5,
                            "reply_to_idx": 0,
                        },
                        {"idx": 0, "sender_id": "a", "text": "first", "offset_s": 50},
                    ],
                }
            ],
        }
    )
    first, second = fx.msg("g", 0), fx.msg("g", 1)
    assert first < second
    reply = await session.get(Message, second)
    assert reply is not None and reply.reply_to == first
    a = await session.get(Membership, (fx.group_id("g"), "a"))
    assert a is not None and a.last_read_message_id == second


# ------------------------------------------------- photos, lore, games, about


@pytest.fixture(autouse=True)
def _media(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    monkeypatch.setattr(settings, "MEDIA_DIR", tmp_path)
    return tmp_path


def _story() -> dict[str, Any]:
    texts = [
        (0, "dad", "59.7 MPG 👏👏 your mother said I drive slow", 9000),
        (2, "kid", "dad is the main character", 8800),
        (3, "mom", "he showed it to everyone 🤣", 8700),
        (6, "kid", "fresh moment nobody saved yet", 600),
        (7, "mom", "😂😂", 500),
    ]
    return {
        "users": [
            {"id": "dad", "username": "dad", "display_name": "Ravi V", "about": "Dad."},
            {"id": "mom", "username": "mom", "display_name": "Lakshmi V"},
            {"id": "kid", "username": "kid", "display_name": "Diya V"},
        ],
        "groups": [
            {
                "key": "home",
                "name": "Home",
                "members": [
                    {"user_id": u, "joined_offset_s": 86400 * 10}
                    for u in ("dad", "mom", "kid")
                ],
                "messages": [
                    *(
                        {"idx": i, "sender_id": who, "text": t, "offset_s": off}
                        for i, who, t, off in texts
                    ),
                    {
                        "idx": 1,
                        "sender_id": "dad",
                        "kind": "photo",
                        "image": "ev-trip-summary.jpg",
                        "image_description": "A car's trip summary screen.",
                        "offset_s": 8900,
                    },
                    {
                        "idx": 4,
                        "sender_id": "kid",
                        "kind": "game",
                        "offset_s": 3600,
                        "game": {
                            "lore_title": "Dad's 59.7 MPG Victory Lap",
                            "prompt": "Someone's MPG Victory Lap",
                            "hints": ["a car", "a screen", "59.7"],
                            "hints_shown": 2,
                            "options": ["dad", "mom", "kid"],
                            "answer": "dad",
                            "status": "revealed",
                            "votes": [
                                {"user_id": "mom", "choice": "dad"},
                                {"user_id": "dad", "choice": "kid", "offset_s": 3000},
                            ],
                            "revealed_offset_s": 1800,
                        },
                    },
                    {
                        "idx": 5,
                        "kind": "system",
                        "sender_id": None,
                        "text": "🎉 It was Dad: Dad's 59.7 MPG Victory Lap",
                        "offset_s": 1800,
                    },
                ],
                "lore": [
                    {
                        "title": "Dad's 59.7 MPG Victory Lap",
                        "message_idxs": [0, 2, 3],
                        "hero_idx": 1,
                        "terms": ["59.7"],
                        "kept_by": "kid",
                    }
                ],
                "lore_backfill_before_idx": 6,
            }
        ],
    }


async def test_photos_lore_games_and_about(
    load_fixture: LoadFixture,
    session: AsyncSession,
    client: AsyncClient,
    _media: Path,
) -> None:
    fx = await load_fixture(_story())
    home = fx.groups["home"]
    dad = await session.get(User, "dad")
    assert dad is not None and dad.about == "Dad."
    assert (await session.get(User, "mom")).about is None  # type: ignore[union-attr]

    photo = await session.get(Message, fx.msg("home", 1))
    assert photo is not None and photo.kind == "photo" and photo.text == ""
    source = (MEDIA_SRC / "ev-trip-summary.jpg").read_bytes()
    assert photo.image_path == hashlib.sha256(source).hexdigest() + ".jpg"
    assert (_media / photo.image_path).read_bytes() == source  # already normalized
    assert (photo.image_width, photo.image_height) == (1200, 1600)
    assert photo.image_description == "A car's trip summary screen."
    served = await client.get(f"/api/v1/media/{photo.image_path}")
    assert served.status_code == 200 and served.content == source

    row = await session.get(Lore, home.lore_ids["Dad's 59.7 MPG Victory Lap"])
    assert row is not None and row.status == "kept" and row.kept_by == "kid"
    assert row.message_ids == sorted(fx.msg("home", i) for i in (0, 1, 2, 3))
    assert row.people == ["dad", "kid", "mom"] and row.terms == ["59.7"]
    assert row.hero_message_id == photo.id
    assert row.events and row.events[0]["message_id"] == photo.id
    assert row.started_at == fx.now - timedelta(seconds=9000)
    assert row.ended_at == row.kept_at == fx.now - timedelta(seconds=8700)

    game = await session.get(LoreGame, home.game_ids[4])
    assert game is not None and game.message_id == fx.msg("home", 4)
    assert (game.started_by, game.answer_id, game.status) == ("kid", "dad", "revealed")
    assert game.revealed_at == fx.now - timedelta(seconds=1800)
    assert {(v.user_id, v.choice) for v in game.votes} == {
        ("mom", "dad"),
        ("dad", "kid"),
    }
    message = await session.get(Message, game.message_id)
    assert message is not None and message.text == "Guess that Lore 🎲"
    assert home.lore_before == fx.msg("home", 6)

    # The API shows the seeded game like a played one.
    page = (
        await client.get(
            f"/api/v1/groups/{home.id}/messages", params={"user_id": "kid"}
        )
    ).json()
    shown = next(m for m in page["messages"] if m["kind"] == "game")["game"]
    assert shown["lore_title"] == "Dad's 59.7 MPG Victory Lap"
    assert shown["answer"]["id"] == "dad" and shown["my_vote"] is None
    assert shown["total_votes"] == 2 and len(shown["hints"]) == 3


async def test_lore_backfill_skips_the_fresh_moment(
    load_fixture: LoadFixture, session: AsyncSession, fake_llm: llm.FakeLLM
) -> None:
    fx = await load_fixture(_story())
    home = fx.groups["home"]
    seen: list[str] = []
    fake_llm.handler = lambda call: seen.append(call.user) or {"moments": []}
    await lore.backfill_group(session, home.id, before=home.lore_before)
    assert seen and "59.7 MPG" in seen[0]
    assert "fresh moment" not in "".join(seen)


@pytest.mark.parametrize(
    ("change", "error"),
    [
        ({"answer": "omar"}, "answer isn't an option"),
        ({"options": ["dad", "omar"]}, "aren't members"),
        ({"votes": [{"user_id": "dad", "choice": "omar"}]}, "vote by dad"),
        ({"lore_title": "Nope"}, "no lore titled"),
        ({"hints_shown": 4}, "hints_shown"),
    ],
)
async def test_bad_games_are_rejected(
    load_fixture: LoadFixture, change: dict[str, Any], error: str
) -> None:
    data = _story()
    game = next(m for m in data["groups"][0]["messages"] if m.get("kind") == "game")
    game["game"] |= change
    with pytest.raises(ValueError, match=error):
        await load_fixture(data)


def test_media_only_copies_every_seed_photo(_media: Path) -> None:
    sources = sorted(p for p in MEDIA_SRC.iterdir() if p.suffix == ".jpg")
    assert copy_all_media() == len(sources) > 0
    expected = {hashlib.sha256(p.read_bytes()).hexdigest() + ".jpg" for p in sources}
    assert {p.name for p in _media.iterdir()} == expected
    assert copy_all_media() == len(sources)  # idempotent
    assert {p.name for p in _media.iterdir()} == expected


@pytest.mark.parametrize("name", ["family.json", "friends.json"])
async def test_new_fixtures_load(
    name: str, load_fixture: LoadFixture, session: AsyncSession
) -> None:
    path = FIXTURES_DIR / name
    if not path.exists():
        pytest.skip(f"{name} isn't written yet")
    fx = await load_fixture(json.loads(path.read_text()))
    for key, group in fx.groups.items():
        count = await session.scalar(
            select(func.count()).where(Message.group_id == group.id)
        )
        assert count == len(group.message_ids) > 0, key
        for title, lore_id in group.lore_ids.items():
            row = await session.get(Lore, lore_id)
            assert row is not None and row.events, title
            if group.lore_before is not None:  # the fresh moment stays unsaved
                assert max(row.message_ids) < group.lore_before, title
    photos = list(await session.scalars(select(Message).where(Message.kind == "photo")))
    assert all(p.image_path and p.image_width and p.image_description for p in photos)
    rows = await session.scalars(select(Message).where(Message.kind == "game"))
    views = await games.attach(
        session, [schemas.Message.model_validate(m) for m in rows], None
    )
    assert all(v.game and v.game.options for v in views)  # every game renders
