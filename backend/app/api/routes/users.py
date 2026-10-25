"""Profiles for trusted demo identities; replace the header with auth before release."""

from fastapi import APIRouter, Header, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.models import UserProfile
from app.pronunciations import (
    DEMO_USERS,
    MAX_AUDIO_BYTES,
    delete_clip,
    get_clip,
    save_clip,
)

router = APIRouter(prefix="/users", tags=["users"])


def check_user(user_id: str) -> None:
    if user_id not in DEMO_USERS:
        raise HTTPException(404, "Profile not found")


def check_owner(user_id: str, demo_user: str | None) -> None:
    check_user(user_id)
    if settings.FASTAPI_ENV != "development":
        raise HTTPException(403, "Demo profile editing is development-only")
    if demo_user != user_id:
        raise HTTPException(403, "You can only edit your own pronunciation")


def profile(user_id: str) -> UserProfile:
    check_user(user_id)
    clip = get_clip(user_id)
    return UserProfile(
        id=user_id,
        display_name=DEMO_USERS[user_id],
        pronunciation_url=(
            f"{settings.API_V1_STR}/users/{user_id}/pronunciation?v={clip['revision']}"
            if clip
            else None
        ),
    )


@router.get("", response_model=list[UserProfile])
def list_users():
    return [profile(user_id) for user_id in DEMO_USERS]


@router.get("/{user_id}", response_model=UserProfile)
def get_user(user_id: str):
    return profile(user_id)


@router.get("/{user_id}/pronunciation")
def audio(user_id: str):
    check_user(user_id)
    clip = get_clip(user_id)
    if clip is None:
        raise HTTPException(404, "No pronunciation recorded yet")
    return Response(
        clip["audio"],
        media_type=clip["content_type"],
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.put("/{user_id}/pronunciation", response_model=UserProfile)
async def upload(
    user_id: str, request: Request, x_demo_user: str | None = Header(default=None)
):
    check_owner(user_id, x_demo_user)
    content_type = request.headers.get("content-type", "").split(";")[0].lower()
    if content_type not in {"audio/mp4", "audio/m4a", "audio/x-m4a", "audio/webm"}:
        raise HTTPException(415, "Use an M4A/MP4 or WebM audio recording")
    audio_bytes = bytearray()
    async for chunk in request.stream():
        if len(audio_bytes) + len(chunk) > MAX_AUDIO_BYTES:
            raise HTTPException(413, "Recording must be smaller than 256 KB")
        audio_bytes.extend(chunk)
    if not audio_bytes:
        raise HTTPException(422, "Recording is empty")
    is_webm = audio_bytes[:4] == b"\x1a\x45\xdf\xa3"
    is_mp4 = audio_bytes[4:8] == b"ftyp"
    if not (is_webm if content_type == "audio/webm" else is_mp4):
        raise HTTPException(422, "Recording does not match its audio format")
    await run_in_threadpool(save_clip, user_id, bytes(audio_bytes), content_type)
    return await run_in_threadpool(profile, user_id)


@router.delete("/{user_id}/pronunciation", status_code=204)
def remove(user_id: str, x_demo_user: str | None = Header(default=None)):
    check_owner(user_id, x_demo_user)
    delete_clip(user_id)
    return Response(status_code=204)
