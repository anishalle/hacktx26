"""Feature 3: catch-up.

Paths: `/catchup`, `/catchup/ask`, `/groups/{group_id}/catchup/preview`.

Logic lives in app/services/catchup.py; background digests in app/services/digests.py.
Routes here carry full paths (no router prefix) because preview sits under /groups.
"""

import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app import schemas
from app.api.deps import SessionDep
from app.core.config import settings
from app.services import catchup

router = APIRouter(tags=["catchup"])
log = logging.getLogger(__name__)

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


@router.get("/groups/{group_id}/catchup/preview", response_model=schemas.CatchupPreview)
async def catchup_preview(
    group_id: int, user_id: str, session: SessionDep
) -> schemas.CatchupPreview:
    rng = await catchup.resolve_range(session, group_id, user_id)
    return schemas.CatchupPreview(
        unread_count=rng.unread_count,
        since_message_id=rng.since_message_id,
        eligible=rng.unread_count >= settings.CATCHUP_MIN_UNREAD,
    )


@router.post(
    "/catchup",
    response_model=None,
    responses={
        200: {
            "model": schemas.CatchupResult,
            "content": {"text/event-stream": {}},
            "description": "SSE (meta, bullet*, term*, done | error); "
            "CatchupResult JSON with ?stream=false",
        }
    },
)
async def run_catchup(
    body: schemas.CatchupRequest, session: SessionDep, stream: bool = True
) -> StreamingResponse | schemas.CatchupResult:
    rng = await catchup.resolve_range(
        session, body.group_id, body.user_id, body.since_message_id
    )
    if stream:
        return StreamingResponse(
            catchup.sse(rng), media_type="text/event-stream", headers=SSE_HEADERS
        )
    try:
        return await catchup.collect(rng)
    except Exception as exc:
        log.exception("catch-up failed for group %s", body.group_id)
        raise HTTPException(502, "Couldn't build the catch-up right now.") from exc


@router.post("/catchup/ask", response_model=schemas.CatchupAskResponse)
async def catchup_ask(
    body: schemas.CatchupAskRequest, session: SessionDep
) -> schemas.CatchupAskResponse:
    question = body.question.strip()
    if not question:
        raise HTTPException(422, "question is empty")
    rng = await catchup.resolve_range(
        session, body.group_id, body.user_id, body.since_message_id
    )
    try:
        return await catchup.ask(session, rng, question)
    except Exception as exc:
        log.exception("catch-up ask failed for group %s", body.group_id)
        raise HTTPException(502, "Couldn't answer that right now.") from exc
