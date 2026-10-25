"""Feature 4: live ? on a group call.

Paths: `/groups/{group_id}/call`, `/calls/{call_id}/leave`, `/calls/{call_id}/explain`,
and the `/calls/{call_id}/audio` WebSocket.

Logic lives in app/services/calls.py and app/services/captions.py; the ? answer reuses
app/services/explain.py.
Routes carry full paths (no router prefix) because the active call sits under /groups.
"""

from fastapi import APIRouter, WebSocket

from app import schemas
from app.api.deps import SessionDep
from app.services import calls, captions

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


@router.websocket("/calls/{call_id}/audio")
async def call_audio(ws: WebSocket, call_id: int, user_id: str) -> None:
    """One member's mic (PCM16 LE, 24 kHz, mono) in; `call.caption` frames out."""
    await captions.relay(ws, call_id, user_id)


@router.post("/calls/{call_id}/explain", response_model=schemas.Explanation)
async def explain_call(
    call_id: int, body: schemas.CallExplainRequest, session: SessionDep
) -> schemas.Explanation:
    return await calls.explain_call(session, call_id, body)
