from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from app import crud, schemas
from app.api.deps import SessionDep
from app.models import Membership, User
from app.services import games

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[schemas.User])
async def list_users(session: SessionDep) -> list[User]:
    return list(await session.scalars(select(User).order_by(User.display_name)))


@router.get("/{user_id}/inbox", response_model=list[schemas.InboxItem])
async def inbox(user_id: str, session: SessionDep) -> list[schemas.InboxItem]:
    """Every group the user is in, newest activity first."""
    if await crud.get_user(session, user_id) is None:
        raise HTTPException(404, "User not found")
    mine = await session.scalars(
        select(Membership).where(Membership.user_id == user_id)
    )
    items: list[tuple[float, schemas.InboxItem]] = []
    for m in mine:
        group = await crud.get_group(session, m.group_id)
        assert group is not None
        last = await crud.latest_message(session, group.id)
        preview = schemas.Message.model_validate(last) if last else None
        if preview is not None:
            await games.attach(session, [preview], user_id)
        item = schemas.InboxItem(
            group=await crud.group_view(session, group, user_id),
            last_message=preview,
            unread_count=await crud.count_unread(session, m),
            last_read_message_id=m.last_read_message_id,
        )
        items.append(((last.ts if last else group.created_at).timestamp(), item))
    items.sort(key=lambda pair: pair[0], reverse=True)
    return [item for _, item in items]
