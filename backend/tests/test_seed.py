from datetime import timedelta

from conftest import LoadFixture
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Membership, Message
from app.seed import LoadedFixture


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
