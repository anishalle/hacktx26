"""Feature 4: live ? on a group call.

Paths: `/groups/{group_id}/call`, `/calls/{call_id}/leave`,
`/calls/{call_id}/transcripts`, `/calls/{call_id}/explain`.

Logic lives in app/services/calls.py; the ? answer reuses app/services/explain.py.
Routes carry full paths (no router prefix) because the active call sits under /groups.
"""

from fastapi import APIRouter

from app import schemas
from app.api.deps import SessionDep
from app.services import calls

router = APIRouter(tags=["calls"])


@router.get("/groups/{group_id}/call", response_model=schemas.Call | None)
async def get_call(group_id: int, session: SessionDep) -> schemas.Call | None:
    return await calls.get_call(session, group_id)


@router.post("/groups/{group_id}/call", response_model=schemas.CallJoin)
async def join_call(
    group_id: int, body: schemas.CallUserRequest, session: SessionDep
) -> schemas.CallJoin:
    return await calls.join(session, group_id, body.user_id)


@router.post("/calls/{call_id}/leave", response_model=schemas.Call)
async def leave_call(
    call_id: int, body: schemas.CallUserRequest, session: SessionDep
) -> schemas.Call:
    return await calls.leave(session, call_id, body.user_id)


@router.post("/calls/{call_id}/transcripts", response_model=schemas.TranscriptStored)
async def store_transcripts(
    call_id: int, body: schemas.TranscriptBatch, session: SessionDep
) -> schemas.TranscriptStored:
    return await calls.ingest(session, call_id, body)


@router.post("/calls/{call_id}/explain", response_model=schemas.Explanation)
async def explain_call(
    call_id: int, body: schemas.CallExplainRequest, session: SessionDep
) -> schemas.Explanation:
    return await calls.explain_call(session, call_id, body)
