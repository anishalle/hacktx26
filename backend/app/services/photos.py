"""Photo messages: store the photo, have Muse describe it, and fold it into the AI's
view of the chat.

An upload is re-encoded as a JPEG (at most MAX_SIDE px, no EXIF, so no location) and
saved under settings.MEDIA_DIR, served at `/api/v1/media/<name>`. The message goes out
right away; Muse then describes the photo in the background (what it shows plus any
visible text) into `image_description`. Every AI feature reads the photo through
digests.message_text, as `[photo: <description>] <caption>`, so search, embeddings,
explanations, catch-up and the call ? button all see it. Windows and digests are
scheduled after the description lands, so they never embed a bare "[photo]".
"""

import asyncio
import base64
import io
import logging
import uuid
from datetime import UTC, datetime

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.core import db
from app.core.config import settings
from app.models import Message
from app.services import digests, embeddings, llm, lore
from app.services.messages import require_member, require_message
from app.services.realtime import broadcast_group

log = logging.getLogger(__name__)

MAX_SIDE = 1600
JPEG_QUALITY = 85
MAX_DESCRIPTION_CHARS = 1500

DESCRIBE_SYSTEM = """You describe a photo shared in a group chat between friends, so \
an assistant can later explain references to it. In 1-3 plain sentences say what it \
shows: the place, objects, activity and mood, and people only by appearance (never \
guess names or who someone is). Then quote any visible text exactly (signs, menus, \
screenshots), prefixed with "Text:". Describe only what is visible."""


def normalize(data: bytes) -> tuple[bytes, int, int]:
    """JPEG bytes (upright, at most MAX_SIDE, no metadata) and their size."""
    try:
        with Image.open(io.BytesIO(data)) as raw:
            image = ImageOps.exif_transpose(raw).convert("RGB")
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("not an image") from exc
    image.thumbnail((MAX_SIDE, MAX_SIDE))
    out = io.BytesIO()
    image.save(out, "JPEG", quality=JPEG_QUALITY, optimize=True)
    return out.getvalue(), image.width, image.height


async def send_photo(
    session: AsyncSession,
    group_id: int,
    sender_id: str,
    data: bytes,
    text: str = "",
    reply_to: int | None = None,
) -> schemas.Message:
    await require_member(session, group_id, sender_id)
    if reply_to is not None:
        await require_message(session, group_id, reply_to)
    if len(data) > settings.MAX_PHOTO_BYTES:
        raise HTTPException(413, "Photos can be at most 15 MB")
    try:
        jpeg, width, height = await asyncio.to_thread(normalize, data)
    except ValueError:
        raise HTTPException(422, "That file isn't a photo we can read") from None
    name = f"{uuid.uuid4().hex}.jpg"
    path = settings.MEDIA_DIR / name
    path.parent.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(path.write_bytes, jpeg)

    message = Message(
        group_id=group_id,
        sender_id=sender_id,
        kind="photo",
        text=text.strip(),
        reply_to=reply_to,
        ts=datetime.now(UTC),
        image_path=name,
        image_width=width,
        image_height=height,
    )
    session.add(message)
    await session.commit()
    await session.refresh(message, ["reactions"])
    out = schemas.Message.model_validate(message)
    await broadcast_group(session, group_id, "message.new", out)
    task = asyncio.get_running_loop().create_task(describe(message.id))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return out


async def describe(message_id: int) -> None:
    """Have Muse describe the photo, then index it like any new message."""
    async with db.SessionLocal() as session:
        message = await session.get(Message, message_id)
        if message is None or not message.image_path:
            return
        group_id = message.group_id
        try:
            jpeg = await asyncio.to_thread(
                (settings.MEDIA_DIR / message.image_path).read_bytes
            )
            url = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
            caption = (
                f'The sender captioned it: "{message.text}".' if message.text else ""
            )
            text = await llm.complete_text(
                DESCRIBE_SYSTEM,
                f"Describe this photo. {caption}".strip(),
                images=[url],
                max_tokens=2500,
            )
            message.image_description = " ".join(text.split())[:MAX_DESCRIPTION_CHARS]
            await session.commit()
        except Exception:
            log.exception("couldn't describe photo %s", message_id)
    digests.schedule_digest(group_id)
    embeddings.schedule_index(group_id)
    lore.schedule_detect(group_id)


_tasks: set[asyncio.Task[None]] = set()


async def drain() -> None:
    """Wait for photo descriptions in flight (tests, scripts)."""
    while _tasks:
        await asyncio.gather(*_tasks, return_exceptions=True)
