"""Save to Lore: POST /groups/{gid}/lore (app/api/routes/lore.py)."""

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Lore, Message
from app.seed import LoadedFixture
from app.services import embeddings, llm
from tests.conftest import WsConnect

URL = "/api/v1"


async def test_save_keeps_the_moment_around_a_message(
    client: AsyncClient,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
    ws_connect: WsConnect,
) -> None:
    gid = sample.group_id("volleyball")
    saved, other = sample.msg("volleyball", 11), sample.msg("volleyball", 12)
    fake_llm.queue(
        {
            "title": "Swayam's house becomes Grandma's",
            "story": "Everyone started calling Swayam's house Grandma's.",
            "key_message_ids": [other, 999999],  # left the saved one out, made one up
            "terms": ["Grandma's"],
        }
    )
    async with ws_connect("maya") as maya:
        resp = await client.post(
            f"{URL}/groups/{gid}/lore", json={"user_id": "priya", "message_id": saved}
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "kept" and body["kept_by"]["id"] == "priya"
        assert body["title"] == "Swayam's house becomes Grandma's"
        assert body["hero_kind"] == "quote"
        frame = await maya.receive_json(timeout=2)
        assert (frame["type"], frame["data"]["id"]) == ("lore.updated", body["id"])
    [call] = fake_llm.calls
    assert call.user.startswith(f"Saved message: #{saved}\n")
    assert f"[#{saved} " in call.user

    feed = (await client.get(f"{URL}/users/maya/lore")).json()["items"]
    assert [i["id"] for i in feed] == [body["id"]]

    # Saving it again (or any message it holds) returns it, no second Muse call.
    again = await client.post(
        f"{URL}/groups/{gid}/lore", json={"user_id": "maya", "message_id": other}
    )
    assert again.json()["id"] == body["id"]
    assert again.json()["kept_by"]["id"] == "priya"
    assert len(fake_llm.calls) == 1


async def test_save_merges_into_matching_kept_lore(
    client: AsyncClient,
    session: AsyncSession,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    gid = sample.group_id("volleyball")
    title, story = "Kobe's serve hits the bleachers", "Kobe served into the stands."
    existing = Lore(
        group_id=gid,
        title=title,
        story=story,
        status="kept",
        source="chat",
        started_at=sample.now,
        ended_at=sample.now,
        message_ids=[sample.msg("volleyball", 3)],
        embedding=await embeddings.embed(f"{title}. {story} "),
    )
    session.add(existing)
    await session.commit()
    saved = sample.msg("volleyball", 20)
    fake_llm.queue({"title": title, "story": story, "key_message_ids": [saved]})

    resp = await client.post(
        f"{URL}/groups/{gid}/lore", json={"user_id": "priya", "message_id": saved}
    )
    assert resp.json()["id"] == existing.id
    await session.refresh(existing)
    assert saved in existing.message_ids
    assert existing.kept_by is None  # merged, not re-kept


async def test_save_falls_back_to_the_message_when_muse_fails(
    client: AsyncClient,
    session: AsyncSession,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    gid = sample.group_id("volleyball")
    saved = await session.get(Message, sample.msg("volleyball", 5))
    assert saved is not None
    fake_llm.handler = lambda call: RuntimeError("muse down")
    resp = await client.post(
        f"{URL}/groups/{gid}/lore", json={"user_id": "priya", "message_id": saved.id}
    )
    assert resp.status_code == 200
    sent = " ".join(saved.text.split())
    title = sent if len(sent) <= 48 else sent[:47].rstrip() + "…"
    assert resp.json()["title"] == title
    assert resp.json()["events"][0]["message"]["id"] == saved.id


async def test_save_checks_membership_and_message(
    client: AsyncClient, sample: LoadedFixture, fake_llm: llm.FakeLLM
) -> None:
    gid = sample.group_id("volleyball")
    saved = sample.msg("volleyball", 5)
    resp = await client.post(
        f"{URL}/groups/{gid}/lore", json={"user_id": "nobody", "message_id": saved}
    )
    assert resp.status_code in (403, 404)
    resp = await client.post(
        f"{URL}/groups/{gid}/lore", json={"user_id": "priya", "message_id": 999999}
    )
    assert resp.status_code == 404
    assert fake_llm.calls == []


async def test_save_into_full_lore_keeps_the_saved_message(
    client: AsyncClient,
    session: AsyncSession,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    gid = sample.group_id("volleyball")
    title, story = "Kobe's serve hits the bleachers", "Kobe served into the stands."
    full = [sample.msg("volleyball", i) for i in range(16)]
    existing = Lore(
        group_id=gid,
        title=title,
        story=story,
        status="kept",
        source="chat",
        started_at=sample.now,
        ended_at=sample.now,
        message_ids=full,
        embedding=await embeddings.embed(f"{title}. {story} "),
    )
    session.add(existing)
    await session.commit()
    saved = sample.msg("volleyball", 20)
    fake_llm.queue({"title": title, "story": story, "key_message_ids": [saved]})

    resp = await client.post(
        f"{URL}/groups/{gid}/lore", json={"user_id": "priya", "message_id": saved}
    )
    assert resp.json()["id"] == existing.id
    await session.refresh(existing)
    assert saved in existing.message_ids and len(existing.message_ids) == 16
    assert full[0] not in existing.message_ids  # the farthest line made room

    # So saving it again finds it, with no second Muse call.
    again = await client.post(
        f"{URL}/groups/{gid}/lore", json={"user_id": "priya", "message_id": saved}
    )
    assert again.json()["id"] == existing.id
    assert len(fake_llm.calls) == 1
