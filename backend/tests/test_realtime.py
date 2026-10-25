import pytest
from conftest import WsConnect
from httpx import AsyncClient
from httpx_ws import WebSocketDisconnect

from app.seed import LoadedFixture


async def test_ping_pong(ws_connect: WsConnect, sample: LoadedFixture) -> None:
    async with ws_connect("priya") as ws:
        await ws.send_json({"type": "ping"})
        assert await ws.receive_json(timeout=2) == {"type": "pong"}


async def test_unknown_user_rejected(
    ws_connect: WsConnect, sample: LoadedFixture
) -> None:
    closed = pytest.RaisesExc(WebSocketDisconnect, check=lambda e: e.code == 1008)
    with pytest.RaisesGroup(closed, flatten_subgroups=True):
        async with ws_connect("nobody") as ws:
            await ws.receive_json(timeout=2)


async def test_fan_out_to_group_members(
    client: AsyncClient, ws_connect: WsConnect, sample: LoadedFixture
) -> None:
    vb, dm = sample.group_id("volleyball"), sample.group_id("dm_maya_jordan")
    async with (
        ws_connect("maya") as maya,
        ws_connect("aakash") as aakash,
    ):
        # Only DM members hear DM traffic.
        sent = await client.post(
            f"/api/v1/groups/{dm}/messages",
            json={"sender_id": "jordan", "text": "paid!"},
        )
        frame = await maya.receive_json(timeout=2)
        assert frame == {"type": "message.new", "data": sent.json()}
        with pytest.raises(TimeoutError):
            await aakash.receive_json(timeout=0.2)

        # Group traffic reaches every member, sender included.
        sent = await client.post(
            f"/api/v1/groups/{vb}/messages",
            json={"sender_id": "aakash", "text": "6:40!"},
        )
        for ws in (maya, aakash):
            assert await ws.receive_json(timeout=2) == {
                "type": "message.new",
                "data": sent.json(),
            }

        mid = sent.json()["id"]
        await client.post(
            f"/api/v1/groups/{vb}/messages/{mid}/reactions",
            json={"user_id": "maya", "emoji": "👍"},
        )
        for ws in (maya, aakash):
            assert await ws.receive_json(timeout=2) == {
                "type": "reaction.updated",
                "data": {
                    "group_id": vb,
                    "message_id": mid,
                    "reactions": [{"emoji": "👍", "user_id": "maya"}],
                },
            }

        await client.post(
            f"/api/v1/groups/{vb}/read", json={"user_id": "maya", "message_id": mid}
        )
        for ws in (maya, aakash):
            assert await ws.receive_json(timeout=2) == {
                "type": "read.updated",
                "data": {"group_id": vb, "user_id": "maya", "message_id": mid},
            }
