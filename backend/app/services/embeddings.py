"""Feature 1 embeddings: Bedrock Titan v2 over windows of EMBEDDING_WINDOW messages.

A window is EMBEDDING_WINDOW consecutive text messages of a group, so a definition and
its usage land in the same vector. Windows are cut after the group's last indexed one,
embedded once at seed time (`index_group`) and in the background as they fill
(`schedule_index`). Background work opens its own session via
`app.core.db.SessionLocal()`, looked up at call time so tests can rebind it.

Test seam: `set_embedder(fake)` / `set_embedder(None)`. `FakeEmbedder` hashes words
into a deterministic vector (the autouse `fake_embedder` pytest fixture installs one).
Without AWS credentials the real embedder turns itself off after the first failure;
`embed` then returns None and retrieval is full-text only.
"""

import asyncio
import hashlib
import json
import logging
import math
import re
from typing import Any, Protocol

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import db
from app.core.config import settings
from app.models import Message, MessageWindow
from app.services.digests import Line, fetch_lines, lines_query

log = logging.getLogger(__name__)

CONCURRENCY = 8
MAX_INPUT_CHARS = 8000  # Titan v2 takes up to 8k tokens; windows are far shorter


class Embedder(Protocol):
    async def embed(self, text: str) -> list[float]: ...


class EmbeddingUnavailable(RuntimeError):
    pass


class BedrockEmbedder:
    def __init__(self) -> None:
        self._client: Any = None
        self.disabled = False

    def _invoke(self, text: str) -> list[float]:
        if self._client is None:
            import boto3

            self._client = boto3.client(
                "bedrock-runtime", region_name=settings.AWS_REGION
            )
        body = {
            "inputText": text,
            "dimensions": settings.EMBEDDING_DIM,
            "normalize": True,
        }
        resp = self._client.invoke_model(
            modelId=settings.EMBEDDING_MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
        return json.loads(resp["body"].read())["embedding"]

    async def embed(self, text: str) -> list[float]:
        if self.disabled:
            raise EmbeddingUnavailable("embeddings are off")
        try:
            return await asyncio.to_thread(self._invoke, text[:MAX_INPUT_CHARS])
        except Exception as exc:
            from botocore.exceptions import ClientError, NoCredentialsError

            denied = isinstance(exc, ClientError) and exc.response["Error"]["Code"] in {
                "AccessDeniedException",
                "UnrecognizedClientException",
            }
            if isinstance(exc, NoCredentialsError) or denied:
                self.disabled = True
                log.warning("Bedrock embeddings unavailable (%s); full-text only", exc)
                raise EmbeddingUnavailable(str(exc)) from exc
            raise


class FakeEmbedder:
    """Bag of hashed words, L2-normalized: texts sharing words are close."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def embed(self, text: str) -> list[float]:
        self.calls.append(text)
        vec = [0.0] * settings.EMBEDDING_DIM
        for word in re.findall(r"\w+", text.lower()):
            digest = hashlib.blake2b(word.encode(), digest_size=4).digest()
            vec[int.from_bytes(digest) % settings.EMBEDDING_DIM] += 1.0
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]


_embedder: Embedder = BedrockEmbedder()


def set_embedder(embedder: Embedder | None) -> None:
    """Install an embedder (tests); None restores Bedrock."""
    global _embedder
    _embedder = embedder if embedder is not None else BedrockEmbedder()


async def embed(text: str) -> list[float] | None:
    """Embedding for `text`, or None when embeddings are unavailable."""
    try:
        return await _embedder.embed(text)
    except EmbeddingUnavailable:
        return None


def window_text(lines: list[Line]) -> str:
    return "\n".join(f"{line.name}: {' '.join(line.text.split())}" for line in lines)


async def index_group(session: AsyncSession, group_id: int) -> int:
    """Embed every full window after the group's last indexed one; returns how many
    were stored. Stops early (keeping what it stored) if embeddings are off."""
    last = await session.scalar(
        select(func.max(MessageWindow.end_message_id)).where(
            MessageWindow.group_id == group_id
        )
    )
    stmt = lines_query(group_id).where(Message.kind == "text")
    if last is not None:
        stmt = stmt.where(Message.id > last)
    lines = await fetch_lines(session, stmt.order_by(Message.id))
    size = settings.EMBEDDING_WINDOW
    windows = [lines[i : i + size] for i in range(0, len(lines) - size + 1, size)]
    if not windows:
        return 0
    vectors: list[list[float] | None] = []
    for i in range(0, len(windows), CONCURRENCY):
        batch = windows[i : i + CONCURRENCY]
        vectors += await asyncio.gather(*(embed(window_text(w)) for w in batch))
        if None in vectors:
            break
    stored = 0
    for window, vector in zip(windows, vectors, strict=False):
        if vector is None:
            break  # windows must stay contiguous: the rest waits for the next run
        await session.execute(
            pg_insert(MessageWindow)
            .values(
                group_id=group_id,
                start_message_id=window[0].id,
                end_message_id=window[-1].id,
                text=window_text(window),
                embedding=vector,
            )
            .on_conflict_do_nothing()
        )
        stored += 1
    await session.commit()
    return stored


async def nearest_windows(
    session: AsyncSession, group_id: int, vector: list[float], limit: int
) -> list[tuple[int, int]]:
    """(start_message_id, end_message_id) of the closest windows, best first."""
    rows = await session.execute(
        select(MessageWindow.start_message_id, MessageWindow.end_message_id)
        .where(MessageWindow.group_id == group_id, MessageWindow.embedding.is_not(None))
        .order_by(MessageWindow.embedding.cosine_distance(vector))
        .limit(limit)
    )
    return [(start, end) for start, end in rows]


_active: set[int] = set()
_again: set[int] = set()
_tasks: set[asyncio.Task[None]] = set()


def schedule_index(group_id: int) -> None:
    """Called after each committed message insert; embeds a window once it fills.
    At most one background task per group (same scheme as digests.schedule_digest)."""
    if group_id in _active:
        _again.add(group_id)
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    _active.add(group_id)
    task = loop.create_task(_index_group(group_id))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def _index_group(group_id: int) -> None:
    try:
        while True:
            _again.discard(group_id)
            async with db.SessionLocal() as session:
                await index_group(session, group_id)
            if group_id not in _again:
                return
    except Exception:
        log.exception("background embedding failed for group %s", group_id)
    finally:
        _active.discard(group_id)


async def drain() -> None:
    """Wait for scheduled background indexing to finish (tests, scripts)."""
    while _tasks:
        await asyncio.gather(*_tasks, return_exceptions=True)
