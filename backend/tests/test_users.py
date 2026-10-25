from httpx import AsyncClient

from app.seed import LoadedFixture


async def test_list_users(client: AsyncClient, sample: LoadedFixture) -> None:
    users = (await client.get("/api/v1/users")).json()
    assert len(users) == 8
    assert [u["display_name"] for u in users] == sorted(
        u["display_name"] for u in users
    )
    priya = next(u for u in users if u["id"] == "priya")
    assert priya == {
        "id": "priya",
        "username": "priya.k",
        "display_name": "Priya Kapoor",
        "avatar_url": None,
        "phonetic_hint": "PREE-yah",
        "pronunciation_audio_url": None,
    }


async def test_inbox_newcomer(client: AsyncClient, sample: LoadedFixture) -> None:
    items = (await client.get("/api/v1/users/priya/inbox")).json()
    assert [i["group"]["id"] for i in items] == [
        sample.group_id("volleyball"),
        sample.group_id("dm_aakash_priya"),
    ]
    vb, dm = items
    # Never read: everything since joining (idx 44..61) minus her own 2 messages.
    assert vb["unread_count"] == 16
    assert vb["last_read_message_id"] is None
    assert vb["last_message"]["id"] == sample.msg("volleyball", 61)
    assert vb["group"]["member_count"] == 8
    assert dm["group"]["name"] == "Aakash Mehta"
    assert dm["group"]["is_dm"] is True
    assert dm["unread_count"] == 0  # only her own reply is after her marker


async def test_inbox_unread_after_marker(
    client: AsyncClient, sample: LoadedFixture
) -> None:
    items = (await client.get("/api/v1/users/sam/inbox")).json()
    vb = items[0]
    # last_read idx 40; idx 41..61 minus sam's own idx 51 and 58.
    assert vb["unread_count"] == 19
    assert vb["last_read_message_id"] == sample.msg("volleyball", 40)
    aakash = (await client.get("/api/v1/users/aakash/inbox")).json()
    assert {i["unread_count"] for i in aakash} == {0}


async def test_inbox_unknown_user(client: AsyncClient) -> None:
    assert (await client.get("/api/v1/users/nobody/inbox")).status_code == 404
