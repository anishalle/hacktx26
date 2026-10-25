import pytest
from httpx import AsyncClient

from app.seed import LoadedFixture
from app.services import digests


async def test_group_detail(client: AsyncClient, sample: LoadedFixture) -> None:
    gid = sample.group_id("volleyball")
    body = (
        await client.get(f"/api/v1/groups/{gid}", params={"user_id": "aakash"})
    ).json()
    assert body["name"] == "Thursday Volleyball 🏐"
    assert body["member_count"] == len(body["members"]) == 8
    members = {m["user"]["id"]: m for m in body["members"]}
    assert members["priya"]["is_newcomer"] is True
    assert members["aakash"]["is_newcomer"] is False
    assert members["priya"]["last_read_message_id"] is None
    assert members["priya"]["joined_at"].endswith("Z")
    assert body["members"][-1]["user"]["id"] == "priya"  # ordered by joined_at


async def test_dm_named_from_viewer_side(
    client: AsyncClient, sample: LoadedFixture
) -> None:
    gid = sample.group_id("dm_maya_jordan")
    maya = (await client.get(f"/api/v1/groups/{gid}?user_id=maya")).json()
    jordan = (await client.get(f"/api/v1/groups/{gid}?user_id=jordan")).json()
    assert maya["name"] == "Jordan Lee"
    assert jordan["name"] == "Maya Chen"


async def test_group_not_found(client: AsyncClient) -> None:
    assert (await client.get("/api/v1/groups/999")).status_code == 404
    assert (await client.get("/api/v1/groups/999/messages")).status_code == 404


def _idx(sample: LoadedFixture, page: dict) -> list[int]:
    ids = {v: k for k, v in sample.groups["volleyball"].message_ids.items()}
    return [ids[m["id"]] for m in page["messages"]]


async def test_messages_newest_page(client: AsyncClient, sample: LoadedFixture) -> None:
    gid = sample.group_id("volleyball")
    page = (await client.get(f"/api/v1/groups/{gid}/messages")).json()
    assert _idx(sample, page) == list(range(12, 62))
    assert page["has_more_before"] is True
    assert page["has_more_after"] is False
    first = page["messages"][0]
    assert first["reply_to"] == sample.msg("volleyball", 11)
    assert set(first) == {
        "id", "group_id", "sender_id", "kind", "text", "ts", "reply_to", "reactions",
        "image", "image_description",
    }  # fmt: skip
    assert first["image"] is None and first["image_description"] is None
    canon = next(m for m in page["messages"] if m["id"] == sample.msg("volleyball", 13))
    assert {r["user_id"] for r in canon["reactions"]} == {"jordan", "maya", "leo"}


@pytest.mark.parametrize(
    ("params", "expected", "more_before", "more_after"),
    [
        ({"before": 20, "limit": 5}, range(15, 20), True, True),
        ({"after": 57}, range(58, 62), True, False),
        ({"after": 2, "before": 6}, range(3, 6), True, True),
        ({"around": 13, "limit": 10}, range(8, 18), True, True),
        ({"around": 1, "limit": 10}, range(0, 10), False, True),
        ({"before": 3}, range(0, 3), False, True),
    ],
)
async def test_messages_cursors(
    client: AsyncClient,
    sample: LoadedFixture,
    params: dict,
    expected: range,
    more_before: bool,
    more_after: bool,
) -> None:
    gid = sample.group_id("volleyball")
    q = {
        k: sample.msg("volleyball", v) if k != "limit" else v for k, v in params.items()
    }
    page = (await client.get(f"/api/v1/groups/{gid}/messages", params=q)).json()
    assert _idx(sample, page) == list(expected)
    assert (page["has_more_before"], page["has_more_after"]) == (
        more_before,
        more_after,
    )


async def test_messages_empty_page_and_limits(
    client: AsyncClient, sample: LoadedFixture
) -> None:
    gid = sample.group_id("volleyball")
    last = sample.msg("volleyball", 61)
    page = (await client.get(f"/api/v1/groups/{gid}/messages?after={last}")).json()
    assert page == {"messages": [], "has_more_before": True, "has_more_after": False}
    url = f"/api/v1/groups/{gid}/messages"
    assert (await client.get(url, params={"limit": 201})).status_code == 422
    assert (await client.get(url, params={"limit": 0})).status_code == 422


async def test_send_message(
    client: AsyncClient, sample: LoadedFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    scheduled: list[int] = []
    monkeypatch.setattr(digests, "schedule_digest", scheduled.append)
    gid = sample.group_id("volleyball")
    reply_to = sample.msg("volleyball", 59)
    resp = await client.post(
        f"/api/v1/groups/{gid}/messages",
        json={"sender_id": "priya", "text": "see you there!", "reply_to": reply_to},
    )
    assert resp.status_code == 201
    msg = resp.json()
    assert msg["group_id"] == gid
    assert msg["sender_id"] == "priya"
    assert msg["kind"] == "text"
    assert msg["reply_to"] == reply_to
    assert msg["reactions"] == []
    assert msg["ts"].endswith("Z")
    assert scheduled == [gid]
    page = (await client.get(f"/api/v1/groups/{gid}/messages?limit=1")).json()
    assert page["messages"][0]["id"] == msg["id"]


async def test_send_message_errors(client: AsyncClient, sample: LoadedFixture) -> None:
    gid = sample.group_id("dm_maya_jordan")
    url = f"/api/v1/groups/{gid}/messages"
    not_member = await client.post(url, json={"sender_id": "priya", "text": "hi"})
    assert not_member.status_code == 403
    empty = await client.post(url, json={"sender_id": "maya", "text": ""})
    assert empty.status_code == 422
    other_group = sample.msg("volleyball", 1)
    bad_reply = await client.post(
        url, json={"sender_id": "maya", "text": "hi", "reply_to": other_group}
    )
    assert bad_reply.status_code == 404


async def test_toggle_reaction(client: AsyncClient, sample: LoadedFixture) -> None:
    gid = sample.group_id("volleyball")
    mid = sample.msg("volleyball", 13)
    url = f"/api/v1/groups/{gid}/messages/{mid}/reactions"
    added = (await client.post(url, json={"user_id": "priya", "emoji": "😂"})).json()
    assert added["id"] == mid
    assert {"emoji": "😂", "user_id": "priya"} in added["reactions"]
    assert len(added["reactions"]) == 4
    removed = (await client.post(url, json={"user_id": "priya", "emoji": "😂"})).json()
    assert {"emoji": "😂", "user_id": "priya"} not in removed["reactions"]
    assert len(removed["reactions"]) == 3
    other = sample.msg("dm_maya_jordan", 0)
    wrong = f"/api/v1/groups/{gid}/messages/{other}/reactions"
    assert (
        await client.post(wrong, json={"user_id": "maya", "emoji": "x"})
    ).status_code == 404


async def test_mark_read(client: AsyncClient, sample: LoadedFixture) -> None:
    gid = sample.group_id("volleyball")
    url = f"/api/v1/groups/{gid}/read"
    mid = sample.msg("volleyball", 55)
    resp = await client.post(url, json={"user_id": "priya", "message_id": mid})
    assert resp.status_code == 204
    assert resp.content == b""
    inbox = (await client.get("/api/v1/users/priya/inbox")).json()
    vb = next(i for i in inbox if i["group"]["id"] == gid)
    assert vb["last_read_message_id"] == mid
    assert vb["unread_count"] == 6  # idx 56..61
    older = sample.msg("volleyball", 50)
    await client.post(url, json={"user_id": "priya", "message_id": older})
    detail = (await client.get(f"/api/v1/groups/{gid}")).json()
    priya = next(m for m in detail["members"] if m["user"]["id"] == "priya")
    assert priya["last_read_message_id"] == mid  # never moves backwards
    other = sample.msg("dm_maya_jordan", 0)
    bad = await client.post(url, json={"user_id": "priya", "message_id": other})
    assert bad.status_code == 404


async def test_glossary(client: AsyncClient, sample: LoadedFixture) -> None:
    gid = sample.group_id("volleyball")
    entries = (await client.get(f"/api/v1/groups/{gid}/glossary")).json()
    assert [e["term"] for e in entries] == ["Grandma", "usual spot"]
    grandma = entries[0]
    assert grandma["id"] == sample.groups["volleyball"].glossary_ids["Grandma"]
    assert grandma["kind"] == "nickname"
    assert grandma["source"] == "seed"
    assert "grandma's" in grandma["aliases"]
    assert grandma["source_message_ids"] == [
        sample.msg("volleyball", i) for i in (10, 12, 13)
    ]
    assert grandma["first_seen_ts"] < grandma["last_explained_ts"]
