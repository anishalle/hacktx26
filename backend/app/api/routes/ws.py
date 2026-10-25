from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status

from app import crud
from app.core import db
from app.services.realtime import hub

router = APIRouter(tags=["realtime"])


@router.websocket("/ws")
async def websocket(ws: WebSocket, user_id: str) -> None:
    """Per-user socket: frames for every group the user is in; answers pings."""
    async with db.SessionLocal() as session:
        known = await crud.get_user(session, user_id) is not None
    if not known:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="Unknown user")
        return
    await ws.accept()
    hub.connect(user_id, ws)
    try:
        while True:
            frame = await ws.receive_json()
            if isinstance(frame, dict) and frame.get("type") == "ping":
                await ws.send_json({"type": "pong"})
    except (WebSocketDisconnect, ValueError):
        pass
    finally:
        hub.disconnect(user_id, ws)
