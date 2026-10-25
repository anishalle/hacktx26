"""Feature 2: pre-send clarity nudge (`/nudge/*`); logic in app/services/nudge.py."""

from fastapi import APIRouter, Response

from app import schemas
from app.api.deps import SessionDep
from app.services import nudge

router = APIRouter(prefix="/nudge", tags=["nudge"])


@router.post("/check", response_model=schemas.NudgeCheck)
async def check(
    body: schemas.NudgeCheckRequest, session: SessionDep
) -> schemas.NudgeCheck:
    return await nudge.check(session, body)


@router.post("/rewrite", response_model=schemas.NudgeRewriteResponse)
async def rewrite(
    body: schemas.NudgeRewriteRequest, session: SessionDep
) -> schemas.NudgeRewriteResponse:
    return await nudge.rewrite(session, body)


@router.post("/unknown", response_model=schemas.NudgeUnknown)
async def unknown(
    body: schemas.NudgeUnknownRequest, session: SessionDep
) -> schemas.NudgeUnknown:
    return await nudge.unknown(session, body)


@router.post("/aside", response_model=schemas.NudgeAsideResponse)
async def aside(
    body: schemas.NudgeAsideRequest, session: SessionDep
) -> schemas.NudgeAsideResponse:
    return await nudge.aside(session, body)


@router.post("/dismiss", status_code=204)
async def dismiss(body: schemas.NudgeDismissRequest, session: SessionDep) -> Response:
    await nudge.dismiss(session, body)
    return Response(status_code=204)
