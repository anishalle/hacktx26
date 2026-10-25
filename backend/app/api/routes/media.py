"""Photo files written by app/services/photos.py. Names are random UUIDs, so they
aren't guessable; anything else is a 404."""

import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.core.config import settings

router = APIRouter(tags=["media"])

_NAME = re.compile(r"[0-9a-f]{32}\.jpg")


@router.get("/media/{name}", response_class=FileResponse)
async def media(name: str) -> FileResponse:
    path = settings.MEDIA_DIR / name
    if not _NAME.fullmatch(name) or not path.is_file():
        raise HTTPException(404, "Not found")
    return FileResponse(
        path,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )
