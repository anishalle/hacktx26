"""Shared database queries. Functions take an AsyncSession; no HTTP concerns."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import ColumnElement, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.core.config import settings
from app.models import Group, Membership, Message, User


def is_newcomer(m: Membership, now: datetime | None = None) -> bool:
    now = now or datetime.now(UTC)
    return m.joined_at > now - timedelta(days=settings.NEWCOMER_BADGE_DAYS)


async def get_group(session: AsyncSession, group_id: int) -> Group | None:
    return await session.get(Group, group_id)


async def get_user(session: AsyncSession, user_id: str) -> User | None:
    return await session.get(User, user_id)


async def get_membership(
    session: AsyncSession, group_id: int, user_id: str
) -> Membership | None:
    return await session.get(Membership, (group_id, user_id))


async def list_memberships(session: AsyncSession, group_id: int) -> list[Membership]:
    stmt = (
        select(Membership)
        .where(Membership.group_id == group_id)
        .order_by(Membership.joined_at)
    )
    return list((await session.scalars(stmt)).all())


async def member_ids(session: AsyncSession, group_id: int) -> list[str]:
    stmt = select(Membership.user_id).where(Membership.group_id == group_id)
    return list((await session.scalars(stmt)).all())


def unread_clause(m: Membership) -> ColumnElement[bool]:
    """Unread messages in m's group: after last_read, else since joining.

    The member's own messages never count as unread.
    """
    after = (
        Message.id > m.last_read_message_id
        if m.last_read_message_id is not None
        else Message.ts >= m.joined_at
    )
    return and_(
        Message.group_id == m.group_id,
        after,
        or_(Message.sender_id.is_(None), Message.sender_id != m.user_id),
    )


async def count_unread(session: AsyncSession, m: Membership) -> int:
    return await session.scalar(select(func.count()).where(unread_clause(m))) or 0


async def first_unread_message_id(session: AsyncSession, m: Membership) -> int | None:
    """Default catch-up start: first message after last_read, else since joining."""
    after = (
        Message.id > m.last_read_message_id
        if m.last_read_message_id is not None
        else Message.ts >= m.joined_at
    )
    stmt = select(func.min(Message.id)).where(Message.group_id == m.group_id, after)
    return await session.scalar(stmt)


async def latest_message(session: AsyncSession, group_id: int) -> Message | None:
    stmt = (
        select(Message)
        .where(Message.group_id == group_id)
        .order_by(Message.id.desc())
        .limit(1)
    )
    return await session.scalar(stmt)


async def group_view(
    session: AsyncSession,
    group: Group,
    viewer_id: str | None,
    memberships: list[Membership] | None = None,
) -> schemas.Group:
    """Group as seen by viewer_id; a DM takes the other member's name and avatar."""
    if memberships is None:
        memberships = await list_memberships(session, group.id)
    name, avatar = group.name, group.avatar_url
    if group.is_dm:
        other = next((m.user for m in memberships if m.user_id != viewer_id), None)
        if other:
            name, avatar = other.display_name, other.avatar_url
    return schemas.Group(
        id=group.id,
        name=name,
        avatar_url=avatar,
        is_dm=group.is_dm,
        member_count=len(memberships),
    )


def member_view(m: Membership, now: datetime | None = None) -> schemas.Member:
    return schemas.Member(
        user=schemas.User.model_validate(m.user),
        joined_at=m.joined_at,
        last_read_message_id=m.last_read_message_id,
        is_newcomer=is_newcomer(m, now),
    )
