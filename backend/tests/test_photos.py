import io
from collections.abc import Iterator
from typing import Any

import pytest
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models import Message
from app.seed import LoadedFixture
from app.services import llm, nudge, photos
from app.services.digests import message_text

URL = "/api/v1"
DESCRIPTION = (
    "A living room with floral couches wrapped in plastic and a candy dish by the "
    "door. Text: GRANDMA'S HOUSE"
)


@pytest.fixture(autouse=True)
def _media(tmp_path, monkeypatch) -> Iterator[None]:
    monkeypatch.setattr(settings, "MEDIA_DIR", tmp_path)
    nudge.invalidate_glossary()
    yield
    nudge.invalidate_glossary()


def jpeg(width: int = 3000, height: int = 2000, *, gps: bool = True) -> bytes:
    image = Image.new("RGB", (width, height), (200, 120, 90))
    exif = Image.Exif()
    if gps:
        exif[0x8825] = {1: "N", 2: (30.0, 17.0, 0.0)}  # GPSInfo
    out = io.BytesIO()
    image.save(out, "JPEG", exif=exif)
    return out.getvalue()


async def _send(
    client: AsyncClient, gid: int, data: bytes, **form: Any
) -> dict[str, Any]:
    resp = await client.post(
        f"{URL}/groups/{gid}/photos",
        data={"sender_id": "swayam", **form},
        files={"file": ("couch.jpg", data, "image/jpeg")},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_photo_is_stored_described_and_searchable(
    client: AsyncClient,
    session: AsyncSession,
    sample: LoadedFixture,
    fake_llm: llm.FakeLLM,
) -> None:
    gid = sample.group_id("volleyball")
    fake_llm.queue(DESCRIPTION)
    out = await _send(client, gid, jpeg(), text="the couches lmao")
    assert (out["kind"], out["text"], out["image_description"]) == (
        "photo",
        "the couches lmao",
        None,  # described in the background
    )
    assert (out["image"]["width"], out["image"]["height"]) == (1600, 1067)
    url = out["image"]["url"]
    assert url.startswith(f"{settings.PUBLIC_URL}{URL}/media/")

    served = await client.get(url.removeprefix(settings.PUBLIC_URL))
    assert served.status_code == 200
    with Image.open(io.BytesIO(served.content)) as stored:
        assert stored.format == "JPEG"
        assert not stored.getexif()  # no location or other metadata

    await photos.drain()
    call = fake_llm.calls[-1]
    assert call.images and call.images[0].startswith("data:image/jpeg;base64,")
    assert '"the couches lmao"' in call.user  # the caption helps the description

    row = await session.get(Message, out["id"])
    await session.refresh(row)
    assert row.image_description == DESCRIPTION
    assert message_text(row) == f"[photo: {DESCRIPTION}] the couches lmao"
    hits = await session.scalars(
        select(Message.id).where(
            Message.group_id == gid, Message.tsv.match("plastic & candy")
        )
    )
    assert out["id"] in list(hits)  # full-text search reads the description

    page = (await client.get(f"{URL}/groups/{gid}/messages?limit=1")).json()
    assert page["messages"][0]["image_description"] == DESCRIPTION


async def test_explaining_a_photo_reads_its_description(
    client: AsyncClient, sample: LoadedFixture, fake_llm: llm.FakeLLM
) -> None:
    gid = sample.group_id("volleyball")
    fake_llm.queue(DESCRIPTION)
    out = await _send(client, gid, jpeg(400, 300))
    await photos.drain()

    def answer(call: llm.LLMCall) -> dict[str, Any]:
        pressed = next(line for line in call.user.splitlines() if line.startswith(">>"))
        assert f"[photo: {DESCRIPTION}]" in pressed
        assert "[G" in call.user  # "GRANDMA'S HOUSE" in the photo matches the glossary
        # Muse looks at the photo itself, not just the stored description
        assert call.images and call.images[0].startswith("data:image/jpeg;base64,")
        return {
            "meaning": "A photo of Swayam's living room, sent to show the couches.",
            "kind": "plain",
            "confidence": 0.9,
        }

    fake_llm.handler = answer
    resp = await client.post(
        f"{URL}/explain",
        json={"group_id": gid, "user_id": "priya", "message_id": out["id"]},
    )
    assert resp.status_code == 200, resp.text
    # a photo is still explained (what it shows, why it was sent), never "plain"
    assert resp.json()["status"] == "explained"


async def test_rejects_non_members_junk_and_huge_files(
    client: AsyncClient, sample: LoadedFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    gid = sample.group_id("volleyball")
    url = f"{URL}/groups/{gid}/photos"

    def post(data: bytes, sender: str = "swayam"):
        return client.post(
            url,
            data={"sender_id": sender},
            files={"file": ("x.jpg", data, "image/jpeg")},
        )

    assert (await post(jpeg(10, 10), sender="nobody")).status_code in (403, 404)
    assert (await post(b"definitely not a jpeg")).status_code == 422
    monkeypatch.setattr(settings, "MAX_PHOTO_BYTES", 100)
    assert (await post(jpeg(10, 10))).status_code == 413
