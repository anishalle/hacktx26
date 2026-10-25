"""Feature 6: Lore.

Paths: `/users/{user_id}/lore`, `/lore/{lore_id}` (+ `/keep`, `/dismiss`, `/remove`),
`/groups/{group_id}/lore/suggestions`.

Logic lives in app/services/lore.py (chat detection, backfill) and
app/services/replays.py (call replays). Routes carry full paths (no router prefix)
because the feed sits under /users and suggestions under /groups.
"""

from typing import Annotated

from fastapi import APIRouter, Query

from app import schemas
from app.api.deps import SessionDep
from app.services import lore

router = APIRouter(tags=["lore"])


@router.get("/users/{user_id}/lore", response_model=schemas.LoreFeed)
async def lore_feed(
    user_id: str,
    session: SessionDep,
    group_id: int | None = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=lore.FEED_MAX)] = 20,
) -> schemas.LoreFeed:
    return await lore.feed(session, user_id, group_id, cursor, limit)


@router.get("/lore/{lore_id}", response_model=schemas.LoreDetail)
async def lore_detail(
    lore_id: int, user_id: str, session: SessionDep
) -> schemas.LoreDetail:
    return await lore.detail(session, lore_id, user_id)


@router.get("/groups/{group_id}/lore/suggestions", response_model=list[schemas.Lore])
async def lore_suggestions(
    group_id: int, user_id: str, session: SessionDep
) -> list[schemas.Lore]:
    return await lore.suggestions(session, group_id, user_id)


@router.post("/lore/{lore_id}/keep", response_model=schemas.Lore)
async def keep_lore(
    lore_id: int, body: schemas.LoreAction, session: SessionDep
) -> schemas.Lore:
    return await lore.keep(session, lore_id, body.user_id)


@router.post("/lore/{lore_id}/dismiss", response_model=schemas.Lore)
async def dismiss_lore(
    lore_id: int, body: schemas.LoreAction, session: SessionDep
) -> schemas.Lore:
    return await lore.dismiss(session, lore_id, body.user_id)


@router.post("/lore/{lore_id}/remove", response_model=schemas.Lore)
async def remove_lore(
    lore_id: int, body: schemas.LoreAction, session: SessionDep
) -> schemas.Lore:
    return await lore.remove(session, lore_id, body.user_id)
