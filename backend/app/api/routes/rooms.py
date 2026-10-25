"""Guest call rooms with signed invitations and room-scoped LiveKit tokens."""

import hashlib
import hmac
import secrets
import time
from datetime import timedelta
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Response
from livekit import api
from pydantic import BaseModel, Field

from app.core.config import settings

router = APIRouter(prefix="/calls/rooms", tags=["calls"])
INVITE_LIFETIME_SECONDS = 24 * 60 * 60


class JoinRoomRequest(BaseModel):
    invite_token: str = Field(min_length=1, max_length=200)
    display_name: str = Field(min_length=1, max_length=60)


def _require_config() -> None:
    if not all((settings.LIVEKIT_URL, settings.LIVEKIT_API_KEY,
                settings.LIVEKIT_API_SECRET)):
        raise HTTPException(503, "Video calls are not configured on this server yet.")
    parsed = urlparse(settings.LIVEKIT_URL)
    local = parsed.hostname in ("localhost", "127.0.0.1", "::1")
    if parsed.scheme != "wss" and not (local and parsed.scheme == "ws"):
        raise HTTPException(503, "The call server needs a secure LiveKit URL.")


def _signature(room_id: str, expires: str) -> str:
    return hmac.new(settings.LIVEKIT_API_SECRET.encode(),
                    f"call-invite:{room_id}:{expires}".encode(),
                    hashlib.sha256).hexdigest()


def _validate_invite(room_id: str, token: str) -> None:
    try:
        expires, signature = token.split(".", 1)
        valid = hmac.compare_digest(signature, _signature(room_id, expires))
        if not valid or int(expires) <= time.time():
            raise ValueError
    except (ValueError, TypeError):
        raise HTTPException(403, "This invitation is invalid or expired. Ask for a new link.") from None


@router.post("")
def create_room(response: Response):
    _require_config()
    room_id = secrets.token_hex(16)
    expires = str(int(time.time()) + INVITE_LIFETIME_SECONDS)
    response.headers["Cache-Control"] = "no-store"
    return {"room_id": room_id, "invite_token": f"{expires}.{_signature(room_id, expires)}"}


@router.post("/{room_id}/join")
def join_room(room_id: str, request: JoinRoomRequest, response: Response):
    _require_config()
    _validate_invite(room_id, request.invite_token)
    name = request.display_name.strip()
    if not name:
        raise HTTPException(422, "Enter your name to join.")
    identity = secrets.token_hex(16)
    token = (
        api.AccessToken(settings.LIVEKIT_API_KEY, settings.LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_name(name)
        .with_ttl(timedelta(minutes=15))
        .with_grants(api.VideoGrants(
            room_join=True, room=room_id, can_publish=True,
            can_subscribe=True, can_publish_data=True,
        ))
        .to_jwt()
    )
    response.headers["Cache-Control"] = "no-store"
    return {"server_url": settings.LIVEKIT_URL, "participant_token": token,
            "participant_identity": identity}
