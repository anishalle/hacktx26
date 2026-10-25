"""Feature 1 fallback: privately ask the member who knows (DESIGN.md, step 3).

The newcomer opts in from the explain sheet; the asked member answers, posts the answer
in chat, or passes. Only the two of them see the ask. An answer is saved to the glossary
(source "human"), so the next explanation and feature 2's nudge both find it.
"""

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.models import MemberAsk, Membership, Message
from app.services import messages, nudge
from app.services.messages import require_group, require_member, require_message
from app.services.realtime import hub

LIST_LIMIT = 50


def phrase_query(*forms: str) -> str:
    """websearch_to_tsquery input matching any of the phrases."""
    phrases = {" ".join(f.replace('"', " ").split()) for f in forms}
    return " OR ".join(f'"{p}"' for p in sorted(phrases) if p)


async def pick_member(
    session: AsyncSession,
    group_id: int,
    requester_id: str,
    sender_id: str | None,
    term: str | None,
) -> Membership | None:
    """Who to ask: the message's sender, else the member who uses the term most."""
    others = {
        m.user_id: m
        for m in await crud.list_memberships(session, group_id)
        if m.user_id != requester_id
    }
    if sender_id in others:
        return others[sender_id]
    query = phrase_query(term) if term else ""
    if not query or not others:
        return None
    top = await session.scalar(
        select(Message.sender_id)
        .where(
            Message.group_id == group_id,
            Message.sender_id.in_(others),
            Message.tsv.op("@@")(func.websearch_to_tsquery("english", query)),
        )
        .group_by(Message.sender_id)
        .order_by(func.count().desc(), Message.sender_id)
        .limit(1)
    )
    return others.get(top) if top else None


async def latest_ask(
    session: AsyncSession, group_id: int, for_user_id: str, term: str
) -> MemberAsk | None:
    return await session.scalar(
        select(MemberAsk)
        .where(
            MemberAsk.group_id == group_id,
            MemberAsk.for_user_id == for_user_id,
            func.lower(MemberAsk.term) == term.lower(),
        )
        .order_by(MemberAsk.id.desc())
        .limit(1)
    )


async def view(
    session: AsyncSession, ask: MemberAsk, viewer_id: str
) -> schemas.MemberAsk:
    group = await require_group(session, ask.group_id)
    message = await session.get(Message, ask.message_id) if ask.message_id else None
    for_user = await crud.get_user(session, ask.for_user_id)
    asked_user = await crud.get_user(session, ask.asked_user_id)
    assert for_user is not None and asked_user is not None  # FKs cascade on delete
    return schemas.MemberAsk(
        id=ask.id,
        group_id=ask.group_id,
        group_name=(await crud.group_view(session, group, viewer_id)).name,
        term=ask.term,
        message=schemas.Message.model_validate(message) if message else None,
        for_user=schemas.User.model_validate(for_user),
        asked_user=schemas.User.model_validate(asked_user),
        status=ask.status,  # type: ignore[arg-type]
        answer=ask.answer,
        posted_message_id=ask.posted_message_id,
        created_at=ask.created_at,
        answered_at=ask.answered_at,
    )


async def create_ask(
    session: AsyncSession, body: schemas.AskCreate
) -> schemas.MemberAsk:
    await require_member(session, body.group_id, body.user_id)
    message = (
        await require_message(session, body.group_id, body.message_id)
        if body.message_id is not None
        else None
    )
    term = " ".join(body.term.split())
    if not term:
        raise HTTPException(422, "term is empty")
    target = await pick_member(
        session,
        body.group_id,
        body.user_id,
        message.sender_id if message else None,
        term,
    )
    if target is None:
        raise HTTPException(409, "There's no one in the group to ask about this.")
    existing = await latest_ask(session, body.group_id, body.user_id, term)
    if existing and existing.status == "pending":
        return await view(session, existing, body.user_id)
    ask = MemberAsk(
        group_id=body.group_id,
        asked_user_id=target.user_id,
        for_user_id=body.user_id,
        term=term,
        message_id=body.message_id,
    )
    session.add(ask)
    await session.commit()
    await session.refresh(ask)
    await hub.send(
        [target.user_id], "ask.new", await view(session, ask, target.user_id)
    )
    return await view(session, ask, body.user_id)


async def list_asks(session: AsyncSession, user_id: str) -> schemas.AskList:
    if await crud.get_user(session, user_id) is None:
        raise HTTPException(404, "User not found")

    async def side(column) -> list[schemas.MemberAsk]:
        rows = await session.scalars(
            select(MemberAsk)
            .where(column == user_id)
            .order_by(MemberAsk.created_at.desc(), MemberAsk.id.desc())
            .limit(LIST_LIMIT)
        )
        return [await view(session, ask, user_id) for ask in rows]

    return schemas.AskList(
        incoming=await side(MemberAsk.asked_user_id),
        outgoing=await side(MemberAsk.for_user_id),
    )


async def answer_ask(
    session: AsyncSession, ask_id: int, body: schemas.AskAnswer
) -> schemas.MemberAsk:
    ask = await session.get(MemberAsk, ask_id)
    # Only the asked member learns the ask exists.
    if ask is None or ask.asked_user_id != body.user_id:
        raise HTTPException(404, "Ask not found")
    if ask.status != "pending":
        raise HTTPException(409, "This ask was already answered or passed.")
    answer = " ".join((body.answer or "").split())
    if not body.decline and not answer:
        raise HTTPException(422, "Write an answer or pass.")
    if body.post_in_chat and not body.decline:
        await require_member(session, ask.group_id, body.user_id)
    ask.status = "declined" if body.decline else "answered"
    ask.answer = None if body.decline else answer
    ask.answered_at = datetime.now(UTC)
    await session.commit()
    if not body.decline:
        await nudge.upsert_human_term(session, ask.group_id, ask.term, answer, None)
        if body.post_in_chat:
            text = (
                answer
                if ask.term.lower() in answer.lower()
                else f"“{ask.term}” = {answer}"
            )
            posted = await messages.send_message(
                session,
                ask.group_id,
                schemas.MessageCreate(sender_id=body.user_id, text=text),
            )
            ask.posted_message_id = posted.id
            await session.commit()
    for viewer in (ask.asked_user_id, ask.for_user_id):
        await hub.send([viewer], "ask.updated", await view(session, ask, viewer))
    return await view(session, ask, body.user_id)
