"""Feature 7: Guess that Lore (app/services/games.py, app/api/routes/games.py)."""

from datetime import timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Lore, LoreGame, Message, User
from app.seed import LoadedFixture
from app.services import games, llm
from app.services import lore as lore_service
from app.services.digests import fetch_lines, lines_query
from tests.conftest import LoadFixture, WsConnect

URL = "/api/v1"
TITLE = "Ravi's 59.7 MPG Victory Lap"

FAMILY: dict[str, Any] = {
    "users": [
        {"id": "ravi", "username": "ravi.v", "display_name": "Ravi Varma"},
        {"id": "meena", "username": "meena.v", "display_name": "Meena Varma"},
        {"id": "kavya", "username": "kavya.v", "display_name": "Kavya Varma"},
        {"id": "dev", "username": "dev.v", "display_name": "Dev Varma"},
        {"id": "omar", "username": "omar.k", "display_name": "Omar Khan"},
    ],
    "groups": [
        {
            "key": "home",
            "name": "Home",
            "members": [
                {"user_id": u, "joined_offset_s": 864000}
                for u in ("ravi", "meena", "kavya", "dev")
            ],
            "messages": [
                {
                    "idx": 0,
                    "sender_id": "ravi",
                    "text": "59.7 MPG 👏",
                    "offset_s": 7200,
                },
                {"idx": 1, "sender_id": "kavya", "text": "ok dad", "offset_s": 7100},
                {"idx": 2, "sender_id": "dev", "text": "slow driver", "offset_s": 7000},
            ],
            "glossary": [
                {
                    "term": "Nanna",
                    "meaning": "What the kids call Dad.",
                    "kind": "nickname",
                    "first_seen_idx": 1,
                }
            ],
        },
        {
            "key": "empty",
            "name": "No lore here",
            "members": [
                {"user_id": u, "joined_offset_s": 86400} for u in ("ravi", "meena")
            ],
            "messages": [
                {"idx": 0, "sender_id": "ravi", "text": "hello", "offset_s": 60}
            ],
        },
    ],
}

GOOD = {
    "prompt": "Someone's Fuel Economy Victory Lap",
    "subject": "ravi",
    "hints": ["It was about a car.", "A screen got shown off.", "Almost 60."],
}


@pytest.fixture
async def family(load_fixture: LoadFixture, session: AsyncSession) -> LoadedFixture:
    fx = await load_fixture(FAMILY)
    session.add(
        Lore(
            group_id=fx.group_id("home"),
            title=TITLE,
            story="Ravi showed off his hybrid's mileage and the kids teased him.",
            status="kept",
            started_at=fx.now - timedelta(hours=2),
            ended_at=fx.now - timedelta(hours=2),
            people=["ravi", "kavya", "dev"],
            message_ids=[fx.msg("home", i) for i in range(3)],
        )
    )
    await session.commit()
    return fx


async def _start(client: AsyncClient, gid: int, user: str = "meena") -> dict[str, Any]:
    resp = await client.post(f"{URL}/groups/{gid}/games", json={"user_id": user})
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_mask_replaces_names_and_keeps_possessives() -> None:
    pattern = games._name_pattern({"Ravi", "ravi.v", "Nanna"})
    assert games.mask(TITLE, pattern) == "Someone's 59.7 MPG Victory Lap"
    assert games.mask("nanna and RAVI", pattern) == "Someone and Someone"
    assert games.mask("Ravindra drove", pattern) == "Ravindra drove"  # whole words
    assert games.has_name("ask ravi.v", pattern)
    assert not games.has_name("a raving review", pattern)


def test_options_are_stable_per_game() -> None:
    members = ["a", "b", "c", "d", "e", "f"]
    picked = games.pick_options(7, "c", members)
    assert picked == games.pick_options(7, "c", members)
    assert "c" in picked and len(picked) == 4 and len(set(picked)) == 4
    assert sorted(games.pick_options(3, "a", ["a", "b"])) == ["a", "b"]


async def test_start_posts_a_game_message(
    client: AsyncClient,
    family: LoadedFixture,
    fake_llm: llm.FakeLLM,
    ws_connect: WsConnect,
) -> None:
    gid = family.group_id("home")
    fake_llm.queue(GOOD)
    async with ws_connect("kavya") as kavya:
        msg = await _start(client, gid)
        frame = await kavya.receive_json(timeout=2)
    assert msg["kind"] == "game" and msg["text"] == games.GAME_TEXT
    assert msg["sender_id"] == "meena"
    game = msg["game"]
    assert game["prompt"] == GOOD["prompt"] and game["question"] == "Who was it?"
    assert game["hints"] == [] and game["hints_total"] == 3
    assert {o["user"]["id"] for o in game["options"]} >= {"ravi"}
    assert len(game["options"]) == 4  # every member fits
    assert game["status"] == "open" and game["answer"] is None
    assert game["lore_title"] is None and game["my_vote"] is None
    assert game["member_count"] == 4 and game["total_votes"] == 0
    assert game["can_reveal"] is True  # the starter

    assert frame["type"] == "message.new" and frame["data"]["id"] == msg["id"]
    assert frame["data"]["game"]["can_reveal"] is False  # not the starter

    [call] = fake_llm.calls
    assert TITLE in call.user and "- ravi: Ravi Varma" in call.user
    assert "59.7 MPG" in call.user  # the moment's lines


async def test_named_prompt_retries_then_masks(
    client: AsyncClient, family: LoadedFixture, fake_llm: llm.FakeLLM
) -> None:
    gid = family.group_id("home")
    fake_llm.queue(
        {**GOOD, "prompt": "Ravi's victory lap"},
        {**GOOD, "prompt": "Nanna's victory lap"},  # a glossary nickname
    )
    game = (await _start(client, gid))["game"]
    assert len(fake_llm.calls) == 2
    assert game["prompt"] == "Someone's 59.7 MPG Victory Lap"
    # fallback hints, vague to specific
    await client.post(f"{URL}/games/{game['id']}/hint", json={"user_id": "dev"})
    resp = await client.post(f"{URL}/games/{game['id']}/hint", json={"user_id": "dev"})
    resp = await client.post(f"{URL}/games/{game['id']}/hint", json={"user_id": "dev"})
    assert resp.json()["game"]["hints"][-1] == "Their name starts with “R”."

    # A subject outside the group or Muse failing also falls back.
    fake_llm.queue({**GOOD, "subject": "omar"}, {**GOOD, "subject": "nobody"})
    assert (await _start(client, gid))["game"]["prompt"].startswith("Someone's")
    fake_llm.queue(llm.LLMError("down"))
    assert (await _start(client, gid))["game"]["prompt"].startswith("Someone's")


async def test_relation_words_are_masked_and_name_the_answer(
    client: AsyncClient,
    session: AsyncSession,
    family: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    """'Dad's ...' gives the answer away like a name: Muse's prompt is checked for
    it, the fallback masks it, and Dad (not the moment's first sender) is the
    answer, called Dad in the reveal."""
    gid = family.group_id("home")
    dad_title = "Dad's 59.7 MPG Victory Lap"
    await session.execute(
        update(Lore).values(title=dad_title, people=["kavya", "dev", "ravi"])
    )
    await session.execute(
        update(User).where(User.id == "ravi").values(about="Dad. 52, engineer.")
    )
    await session.commit()
    assert games.relation(await session.get(User, "ravi")) == "Dad"

    # Muse names Dad twice and returns no member: the fallback guesses Dad.
    fake_llm.queue(
        {**GOOD, "prompt": "Dad's victory lap", "subject": "nobody"},
        {**GOOD, "prompt": "Mom watched a victory lap", "subject": "nobody"},
    )
    game = (await _start(client, gid))["game"]
    assert game["prompt"] == "Someone's 59.7 MPG Victory Lap"
    row = await session.get(LoreGame, game["id"], populate_existing=True)
    assert row is not None and row.answer_id == "ravi"
    assert row.hints[1] == "It's saved with a few messages in this chat's Lore."
    assert row.hints[2] == "Their name starts with “R”."
    resp = await client.post(
        f"{URL}/games/{game['id']}/reveal", json={"user_id": "meena"}
    )
    assert resp.json()["game"]["answer"]["id"] == "ravi"
    texts = list(
        await session.scalars(select(Message.text).where(Message.kind == "system"))
    )
    assert f"🎉 It was Dad: {dad_title}" in texts

    # Muse's answer is kept even when its prompt is rejected.
    fake_llm.queue(
        {**GOOD, "prompt": "Dad's lap", "subject": "dev"},
        {**GOOD, "prompt": "Dad's lap", "subject": "dev"},
    )
    game = (await _start(client, gid))["game"]
    row = await session.get(LoreGame, game["id"], populate_existing=True)
    assert row is not None and row.answer_id == "dev"
    assert row.hints[2] == "Their name starts with “D”."


async def test_muse_errors_and_odd_hints_fall_back(
    client: AsyncClient,
    session: AsyncSession,
    family: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    gid = family.group_id("home")
    fake_llm.queue(RuntimeError("rate limited"))  # any transport/API error
    game = (await _start(client, gid))["game"]
    assert game["prompt"] == "Someone's 59.7 MPG Victory Lap"

    fake_llm.queue({**GOOD, "hints": "It was about a car"})  # a string, not a list
    game = (await _start(client, gid))["game"]
    row = await session.get(LoreGame, game["id"], populate_existing=True)
    assert row is not None and row.prompt == GOOD["prompt"]
    assert row.hints[0].startswith("It happened") and len(row.hints) == 3


async def test_game_lines_read_with_their_round(
    client: AsyncClient,
    session: AsyncSession,
    family: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    gid = family.group_id("home")
    fake_llm.queue(GOOD)
    msg = await _start(client, gid)
    [line] = await fetch_lines(session, lines_query(gid).where(Message.id == msg["id"]))
    lore_id = await session.scalar(select(Lore.id).where(Lore.group_id == gid))
    assert line.text == f"Guess that Lore: {GOOD['prompt']} (about lore #{lore_id})"


async def test_named_hints_are_replaced(
    client: AsyncClient, family: LoadedFixture, fake_llm: llm.FakeLLM
) -> None:
    fake_llm.queue({**GOOD, "hints": ["Ravi drove it.", "Almost 60."]})
    game = (await _start(client, family.group_id("home")))["game"]
    for _ in range(3):
        resp = await client.post(
            f"{URL}/games/{game['id']}/hint", json={"user_id": "kavya"}
        )
    hints = resp.json()["game"]["hints"]
    assert hints[0] == "Almost 60." and len(hints) == 3
    assert not any("Ravi" in h for h in hints)


async def test_no_lore_or_non_member(
    client: AsyncClient, family: LoadedFixture
) -> None:
    resp = await client.post(
        f"{URL}/groups/{family.group_id('empty')}/games", json={"user_id": "ravi"}
    )
    assert resp.status_code == 409
    resp = await client.post(
        f"{URL}/groups/{family.group_id('home')}/games", json={"user_id": "omar"}
    )
    assert resp.status_code == 403


async def test_votes_hints_and_auto_reveal(
    client: AsyncClient,
    session: AsyncSession,
    family: LoadedFixture,
    fake_llm: llm.FakeLLM,
    ws_connect: WsConnect,
) -> None:
    gid = family.group_id("home")
    fake_llm.queue(GOOD)
    game = (await _start(client, gid))["game"]
    gurl = f"{URL}/games/{game['id']}"
    wrong = next(o["user"]["id"] for o in game["options"] if o["user"]["id"] != "ravi")

    assert (
        await client.post(f"{gurl}/vote", json={"user_id": "omar", "choice": "ravi"})
    ).status_code == 403
    assert (
        await client.post(f"{gurl}/vote", json={"user_id": "dev", "choice": "omar"})
    ).status_code == 422
    assert (
        await client.post(
            f"{URL}/games/999/vote", json={"user_id": "dev", "choice": "ravi"}
        )
    ).status_code == 404

    async with ws_connect("kavya") as kavya, ws_connect("dev") as dev:
        resp = await client.post(
            f"{gurl}/vote", json={"user_id": "dev", "choice": wrong}
        )
        mine = resp.json()["game"]
        assert mine["my_vote"] == wrong and mine["total_votes"] == 1
        voted = next(o for o in mine["options"] if o["user"]["id"] == wrong)
        assert voted["votes"] == 1 and voted["voters"] == []  # counts only, for now
        k_frame, d_frame = (
            await kavya.receive_json(timeout=2),
            await dev.receive_json(timeout=2),
        )
        assert k_frame["type"] == d_frame["type"] == "message.updated"
        assert k_frame["data"]["game"]["my_vote"] is None  # per viewer
        assert d_frame["data"]["game"]["my_vote"] == wrong

        # Hints are shared and unlock one at a time.
        resp = await client.post(f"{gurl}/hint", json={"user_id": "kavya"})
        assert resp.json()["game"]["hints"] == GOOD["hints"][:1]
        assert (await dev.receive_json(timeout=2))["data"]["game"]["hints"] == (
            GOOD["hints"][:1]
        )

    # Changing a vote replaces it.
    resp = await client.post(f"{gurl}/vote", json={"user_id": "dev", "choice": "ravi"})
    assert resp.json()["game"]["my_vote"] == "ravi"
    assert resp.json()["game"]["total_votes"] == 1

    # Not the starter, not everyone voted, not a day old: no reveal yet.
    resp = await client.post(f"{gurl}/reveal", json={"user_id": "dev"})
    assert resp.status_code == 403

    for user in ("ravi", "meena"):
        resp = await client.post(
            f"{gurl}/vote", json={"user_id": user, "choice": "ravi"}
        )
        assert resp.json()["game"]["status"] == "open"
    async with ws_connect("ravi") as ravi:
        resp = await client.post(
            f"{gurl}/vote", json={"user_id": "kavya", "choice": wrong}
        )  # the last vote reveals
        updated = await ravi.receive_json(timeout=2)
        line = await ravi.receive_json(timeout=2)
    out = resp.json()["game"]
    assert out["status"] == "revealed" and out["answer"]["id"] == "ravi"
    assert out["lore_title"] == TITLE and out["revealed_at"]
    assert out["hints"] == GOOD["hints"]  # all of them, once revealed
    assert out["can_reveal"] is False
    right = next(o for o in out["options"] if o["user"]["id"] == "ravi")
    assert {u["id"] for u in right["voters"]} == {"dev", "ravi", "meena"}
    assert updated["type"] == "message.updated"
    assert updated["data"]["game"]["my_vote"] == "ravi"
    assert line["type"] == "message.new" and line["data"]["kind"] == "system"
    assert line["data"]["text"] == f"🎉 It was Ravi: {TITLE}"

    for path, body in (
        ("vote", {"user_id": "dev", "choice": wrong}),
        ("hint", {"user_id": "dev"}),
        ("reveal", {"user_id": "meena"}),
    ):
        assert (await client.post(f"{gurl}/{path}", json=body)).status_code == 409

    # The thread page and the inbox carry the game, as the viewer sees it.
    page = (
        await client.get(f"{URL}/groups/{gid}/messages", params={"user_id": "kavya"})
    ).json()["messages"]
    shown = next(m for m in page if m["kind"] == "game")
    assert shown["game"]["my_vote"] == wrong and shown["game"]["status"] == "revealed"
    assert page[-1]["kind"] == "system"
    inbox = (await client.get(f"{URL}/users/kavya/inbox")).json()
    home = next(i for i in inbox if i["group"]["id"] == gid)
    assert home["last_message"]["kind"] == "system"
    texts = await session.scalars(select(Message.text).where(Message.group_id == gid))
    assert f"🎉 It was Ravi: {TITLE}" in list(texts)


async def test_talk_after_a_round_merges_into_its_lore(
    client: AsyncClient,
    session: AsyncSession,
    family: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    """The reminiscing after a reveal strengthens the round's lore, not a new one."""
    gid = family.group_id("home")
    fake_llm.queue(GOOD)
    game = (await _start(client, gid))["game"]
    await client.post(f"{URL}/games/{game['id']}/reveal", json={"user_id": "meena"})
    ids = []
    for who, text in (("kavya", "omg the mpg saga"), ("ravi", "59.7 is a record 😊")):
        resp = await client.post(
            f"{URL}/groups/{gid}/messages", json={"sender_id": who, "text": text}
        )
        ids.append(resp.json()["id"])
    target = await lore_service._similar(session, gid, None, [], message_ids=ids)
    assert target is not None and target.id == game["lore_id"]

    # Long after the round, the same words are just new chat.
    await session.execute(
        update(LoreGame).values(
            created_at=family.now - timedelta(days=3),
            revealed_at=family.now - timedelta(days=3),
        )
    )
    await session.commit()
    assert await lore_service._similar(session, gid, None, [], message_ids=ids) is None


async def test_reveal_rules(
    client: AsyncClient,
    session: AsyncSession,
    family: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    gid = family.group_id("home")
    fake_llm.handler = lambda call: GOOD
    first = (await _start(client, gid, "meena"))["game"]
    resp = await client.post(
        f"{URL}/games/{first['id']}/reveal", json={"user_id": "meena"}
    )
    assert resp.status_code == 200 and resp.json()["game"]["status"] == "revealed"

    second = (await _start(client, gid, "meena"))["game"]
    surl = f"{URL}/games/{second['id']}/reveal"
    assert (await client.post(surl, json={"user_id": "kavya"})).status_code == 403
    await session.execute(
        update(LoreGame)
        .where(LoreGame.id == second["id"])
        .values(created_at=LoreGame.created_at - timedelta(hours=25))
    )
    await session.commit()
    page = (
        await client.get(f"{URL}/groups/{gid}/messages", params={"user_id": "kavya"})
    ).json()["messages"]
    assert next(m for m in page if m["id"] == second["message_id"])["game"][
        "can_reveal"
    ]
    assert (await client.post(surl, json={"user_id": "kavya"})).status_code == 200
    assert (await client.post(surl, json={"user_id": "omar"})).status_code == 403

    # Inbox preview of a game message.
    fake_llm.queue(GOOD)
    third = await _start(client, gid, "dev")
    inbox = (await client.get(f"{URL}/users/ravi/inbox")).json()
    home = next(i for i in inbox if i["group"]["id"] == gid)
    assert home["last_message"]["id"] == third["id"]
    assert home["last_message"]["game"]["prompt"] == GOOD["prompt"]


async def test_prefers_lore_not_played_lately(
    client: AsyncClient,
    session: AsyncSession,
    family: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    gid = family.group_id("home")
    session.add(
        Lore(
            group_id=gid,
            title="Kavya's Lindt run",
            story="Kavya bought every chocolate bag.",
            status="kept",
            started_at=family.now,
            ended_at=family.now,
            people=["kavya"],
        )
    )
    session.add(  # not kept: never picked
        Lore(
            group_id=gid,
            title="Dev's nap",
            story="Dev slept.",
            status="suggested",
            started_at=family.now,
            ended_at=family.now,
            people=["dev"],
        )
    )
    await session.commit()
    fake_llm.handler = lambda call: {
        **GOOD,
        "subject": "kavya" if "Lindt" in call.user else "ravi",
    }
    seen = []
    for _ in range(4):
        game = (await _start(client, gid))["game"]
        seen.append(game["lore_id"])
    assert len(set(seen[:2])) == 2  # the other moment comes before a repeat
    assert all("Dev's nap" not in c.user for c in fake_llm.calls)
