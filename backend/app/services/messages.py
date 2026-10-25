from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.models import Group, Membership, Message, Reaction
from app.services import digests
from app.services.realtime import broadcast_group


async def require_group(session: AsyncSession, group_id: int) -> Group:
    group = await crud.get_group(session, group_id)
    if group is None:
        raise HTTPException(404, "Group not found")
    return group


async def require_member(
    session: AsyncSession, group_id: int, user_id: str
) -> Membership:
    await require_group(session, group_id)
    membership = await crud.get_membership(session, group_id, user_id)
    if membership is None:
        raise HTTPException(403, f"{user_id} is not a member of group {group_id}")
    return membership


async def require_message(
    session: AsyncSession, group_id: int, message_id: int
) -> Message:
    message = await session.get(Message, message_id)
    if message is None or message.group_id != group_id:
        raise HTTPException(404, "Message not found")
    return message


async def _exists(session: AsyncSession, *where) -> bool:
    return bool(await session.scalar(select(exists().where(*where))))


async def page_messages(
    session: AsyncSession,
    group_id: int,
    *,
    before: int | None = None,
    after: int | None = None,
    around: int | None = None,
    limit: int = 50,
) -> schemas.MessagePage:
    await require_group(session, group_id)
    base = select(Message).where(Message.group_id == group_id)
    if around is not None:
        older = await session.scalars(
            base.where(Message.id < around)
            .order_by(Message.id.desc())
            .limit(limit // 2)
        )
        rows = list(older)[::-1]
        newer = await session.scalars(
            base.where(Message.id >= around)
            .order_by(Message.id)
            .limit(limit - len(rows))
        )
        rows += list(newer)
    elif after is not None:
        stmt = base.where(Message.id > after)
        if before is not None:
            stmt = stmt.where(Message.id < before)
        rows = list(await session.scalars(stmt.order_by(Message.id).limit(limit)))
    else:
        stmt = base.where(Message.id < before) if before is not None else base
        rows = list(
            await session.scalars(stmt.order_by(Message.id.desc()).limit(limit))
        )[::-1]

    in_group = Message.group_id == group_id
    if rows:
        lo, hi = rows[0].id, rows[-1].id
        has_before = await _exists(session, in_group, Message.id < lo)
        has_after = await _exists(session, in_group, Message.id > hi)
    else:
        cursor = (
            around if around is not None else after if after is not None else before
        )
        has_before = cursor is not None and await _exists(
            session, in_group, Message.id < cursor
        )
        has_after = cursor is not None and await _exists(
            session, in_group, Message.id > cursor
        )
    return schemas.MessagePage(
        messages=[schemas.Message.model_validate(m) for m in rows],
        has_more_before=has_before,
        has_more_after=has_after,
    )


async def send_message(
    session: AsyncSession, group_id: int, body: schemas.MessageCreate
) -> schemas.Message:
    await require_member(session, group_id, body.sender_id)
    if body.reply_to is not None:
        await require_message(session, group_id, body.reply_to)
    message = Message(
        group_id=group_id,
        sender_id=body.sender_id,
        kind="text",
        text=body.text,
        reply_to=body.reply_to,
        ts=datetime.now(UTC),
    )
    session.add(message)
    await session.commit()
    await session.refresh(message, ["reactions"])
    out = schemas.Message.model_validate(message)
    await broadcast_group(session, group_id, "message.new", out)
    digests.schedule_digest(group_id)
    from app.services import nudge  # local: nudge imports this module

    await nudge.record_explanations(session, group_id, message.text, message.ts)
    return out


async def toggle_reaction(
    session: AsyncSession, group_id: int, message_id: int, body: schemas.ReactionToggle
) -> schemas.Message:
    await require_member(session, group_id, body.user_id)
    message = await require_message(session, group_id, message_id)
    existing = await session.get(Reaction, (message_id, body.user_id, body.emoji))
    if existing is not None:
        await session.delete(existing)
    else:
        session.add(
            Reaction(message_id=message_id, user_id=body.user_id, emoji=body.emoji)
        )
    await session.commit()
    await session.refresh(message, ["reactions"])
    out = schemas.Message.model_validate(message)
    event = schemas.ReactionUpdated(
        group_id=group_id, message_id=message_id, reactions=out.reactions
    )
    await broadcast_group(session, group_id, "reaction.updated", event)
    return out


async def mark_read(
    session: AsyncSession, group_id: int, body: schemas.ReadUpdate
) -> None:
    """Advance the member's read marker (never moves it backwards)."""
    membership = await require_member(session, group_id, body.user_id)
    await require_message(session, group_id, body.message_id)
    current = membership.last_read_message_id
    if current is None or body.message_id > current:
        membership.last_read_message_id = body.message_id
        await session.commit()
    event = schemas.ReadUpdated(
        group_id=group_id,
        user_id=body.user_id,
        message_id=membership.last_read_message_id,
    )
    await broadcast_group(session, group_id, "read.updated", event)
