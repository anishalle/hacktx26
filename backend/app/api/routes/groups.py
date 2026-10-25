from typing import Annotated

from fastapi import APIRouter, File, Form, Query, Response, UploadFile
from sqlalchemy import select

from app import crud, schemas
from app.api.deps import SessionDep
from app.core.config import settings
from app.models import Glossary
from app.services import messages, photos

router = APIRouter(prefix="/groups", tags=["groups"])


@router.get("/{group_id}", response_model=schemas.GroupDetail)
async def group_detail(
    group_id: int, session: SessionDep, user_id: str | None = None
) -> schemas.GroupDetail:
    group = await messages.require_group(session, group_id)
    memberships = await crud.list_memberships(session, group_id)
    view = await crud.group_view(session, group, user_id, memberships)
    return schemas.GroupDetail(
        **view.model_dump(), members=[crud.member_view(m) for m in memberships]
    )


@router.get("/{group_id}/messages", response_model=schemas.MessagePage)
async def list_messages(
    group_id: int,
    session: SessionDep,
    before: int | None = None,
    after: int | None = None,
    around: int | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> schemas.MessagePage:
    return await messages.page_messages(
        session, group_id, before=before, after=after, around=around, limit=limit
    )


@router.post("/{group_id}/photos", response_model=schemas.Message, status_code=201)
async def send_photo(
    group_id: int,
    session: SessionDep,
    file: Annotated[UploadFile, File()],
    sender_id: Annotated[str, Form()],
    text: Annotated[str, Form(max_length=4000)] = "",
    reply_to: Annotated[int | None, Form()] = None,
) -> schemas.Message:
    """A photo message (JPEG/PNG); Muse describes it in the background."""
    data = await file.read(settings.MAX_PHOTO_BYTES + 1)
    return await photos.send_photo(session, group_id, sender_id, data, text, reply_to)


@router.post("/{group_id}/messages", response_model=schemas.Message, status_code=201)
async def send_message(
    group_id: int, body: schemas.MessageCreate, session: SessionDep
) -> schemas.Message:
    return await messages.send_message(session, group_id, body)


@router.post(
    "/{group_id}/messages/{message_id}/reactions", response_model=schemas.Message
)
async def toggle_reaction(
    group_id: int, message_id: int, body: schemas.ReactionToggle, session: SessionDep
) -> schemas.Message:
    return await messages.toggle_reaction(session, group_id, message_id, body)


@router.post("/{group_id}/read", status_code=204)
async def mark_read(
    group_id: int, body: schemas.ReadUpdate, session: SessionDep
) -> Response:
    await messages.mark_read(session, group_id, body)
    return Response(status_code=204)


@router.get("/{group_id}/glossary", response_model=list[schemas.GlossaryEntry])
async def glossary(group_id: int, session: SessionDep) -> list[Glossary]:
    await messages.require_group(session, group_id)
    stmt = select(Glossary).where(Glossary.group_id == group_id).order_by(Glossary.term)
    return list(await session.scalars(stmt))
