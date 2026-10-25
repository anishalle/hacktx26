"""Background chunk digests for catch-up.

Every settings.DIGEST_CHUNK_SIZE consecutive messages in a group (aligned from the
group's first message) are summarized once into `chunk_digests`. Background work
opens its own session via `app.core.db.SessionLocal()`, looked up at call time so
tests can rebind it.
"""

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import Select, case, func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import db
from app.core.config import settings
from app.models import ChunkDigest, Message, User
from app.services import llm

log = logging.getLogger(__name__)

DISPLAY_TZ = ZoneInfo("America/Chicago")
CONCURRENCY = 6
BACKOFF_S = 30.0  # background retry delay after a chunk fails; doubles per failure
BACKOFF_MAX_S = 600.0
SECTIONS = ("events", "decisions", "open_questions")
MAX_LINE_CHARS = 400

DIGEST_SYSTEM = """You summarize one slice of a group chat for a member who missed it.
Input lines look like `[#<message id> <HH:MM> <name>] text`, under `--- <day> ---`
headers. Return only a JSON object:
{"events": [{"text": str, "start_message_id": int, "end_message_id": int}],
 "decisions": [same shape], "open_questions": [same shape],
 "terms": [str], "mood": str}
- events: 2-6 things that happened, in order. One concrete sentence each: who, what,
  when. Skip greetings and filler.
- decisions: plans or agreements the group settled on, with times and places.
- open_questions: questions or plans still unresolved at the end of the slice.
- terms: nicknames, inside jokes and slang the group uses without explaining.
- mood: a few words on the tone.
- Use [] for an empty list. Start/end ids must be message ids from the input,
  start <= end, marking where it happens.
Be terse."""


@dataclass(frozen=True)
class Line:
    id: int
    ts: datetime
    text: str
    name: str


@dataclass(frozen=True)
class Chunk:
    start_id: int
    end_id: int


def message_text(m: Any = Message) -> Any:
    """How the AI reads a message: a photo is `[photo: <description>] <caption>`.
    Takes the Message class (a SQL expression) or a Message row (a string)."""
    if m is Message:
        described = func.concat(
            "[photo: ",
            func.coalesce(Message.image_description, "not described yet"),
            "] ",
            Message.text,
        )
        return case((Message.kind == "photo", described), else_=Message.text)
    if m.kind != "photo":
        return m.text
    return f"[photo: {m.image_description or 'not described yet'}] {m.text}".strip()


def lines_query(group_id: int) -> Select[Any]:
    """Select Line columns for a group's messages; callers add filters and order."""
    return (
        select(
            Message.id,
            Message.ts,
            message_text().label("text"),
            func.coalesce(User.display_name, "system").label("name"),
        )
        .outerjoin(User, User.id == Message.sender_id)
        .where(Message.group_id == group_id)
    )


async def fetch_lines(session: AsyncSession, stmt: Select[Any]) -> list[Line]:
    return [Line(*row) for row in await session.execute(stmt)]


def local(ts: datetime) -> datetime:
    return ts.astimezone(DISPLAY_TZ)


def render_lines(lines: list[Line]) -> str:
    """`[#id HH:MM name] text` per message, with a header whenever the day changes."""
    out: list[str] = []
    day = None
    for line in lines:
        ts = local(line.ts)
        if ts.date() != day:
            day = ts.date()
            out.append(f"--- {ts:%a %b} {ts.day} ---")
        body = " ".join(line.text.split())[:MAX_LINE_CHARS]
        out.append(f"[#{line.id} {ts:%H:%M} {line.name}] {body}")
    return "\n".join(out)


def as_id(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        value = value.strip().lstrip("#")
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def clamp_span(item: dict[str, Any], lo: int, hi: int) -> tuple[int, int] | None:
    """Ids clamped into [lo, hi]; None when neither id points inside the range."""
    start, end = as_id(item.get("start_message_id")), as_id(item.get("end_message_id"))
    ids = [i for i in (start, end) if i is not None]
    if not any(lo <= i <= hi for i in ids):
        return None
    start = start if start is not None else end
    end = end if end is not None else start
    assert start is not None and end is not None
    start, end = sorted((min(max(start, lo), hi), min(max(end, lo), hi)))
    return start, end


def clean_digest(data: dict[str, Any], lo: int, hi: int) -> dict[str, Any]:
    """Validate a model digest: keep well-formed items whose ids fall in [lo, hi]."""
    out: dict[str, Any] = {}
    for section in SECTIONS:
        items = data.get(section)
        out[section] = []
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            body = item.get("text")
            span = clamp_span(item, lo, hi)
            if isinstance(body, str) and body.strip() and span:
                out[section].append(
                    {
                        "text": body.strip(),
                        "start_message_id": span[0],
                        "end_message_id": span[1],
                    }
                )
    terms = data.get("terms")
    out["terms"] = [
        t.strip() for t in terms if isinstance(t, str) and t.strip()
    ][:15] if isinstance(terms, list) else []  # fmt: skip
    mood = data.get("mood")
    out["mood"] = mood.strip() if isinstance(mood, str) else ""
    return out


async def summarize(
    lines: list[Line], *, timeout: float | None = None
) -> dict[str, Any]:
    """One LLM digest over consecutive lines (ids constrained to those lines)."""
    call = llm.complete_json(DIGEST_SYSTEM, render_lines(lines), max_tokens=4000)
    data = await asyncio.wait_for(call, timeout)
    return clean_digest(data, lines[0].id, lines[-1].id)


_CHUNKS_SQL = text("""
SELECT min(id) AS start_id, max(id) AS end_id
FROM (
    SELECT id, (row_number() OVER (ORDER BY id) - 1) / :size AS k
    FROM messages WHERE group_id = :group_id
) numbered
GROUP BY k
HAVING count(*) = :size
ORDER BY k
""")


async def pending_chunks(
    session: AsyncSession,
    group_id: int,
    *,
    min_id: int | None = None,
    max_id: int | None = None,
) -> list[Chunk]:
    """Complete, undigested chunks, optionally only those inside [min_id, max_id]."""
    params = {"group_id": group_id, "size": settings.DIGEST_CHUNK_SIZE}
    rows = await session.execute(_CHUNKS_SQL, params)
    done = set(
        await session.scalars(
            select(ChunkDigest.start_message_id).where(ChunkDigest.group_id == group_id)
        )
    )
    return [
        Chunk(start, end)
        for start, end in rows
        if start not in done
        and (min_id is None or start >= min_id)
        and (max_id is None or end <= max_id)
    ]


async def _store(
    session: AsyncSession, group_id: int, lines: list[Line], digest: dict[str, Any]
) -> bool:
    stmt = (
        pg_insert(ChunkDigest)
        .values(
            group_id=group_id,
            start_message_id=lines[0].id,
            end_message_id=lines[-1].id,
            start_ts=lines[0].ts,
            end_ts=lines[-1].ts,
            message_count=len(lines),
            digest=digest,
        )
        .on_conflict_do_nothing(index_elements=["group_id", "start_message_id"])
        .returning(ChunkDigest.id)
    )
    created = await session.scalar(stmt)
    await session.commit()
    return created is not None


_failures: dict[tuple[int, int], tuple[int, float]] = {}  # chunk -> (n, retry_at)


def _record_failure(group_id: int, start_id: int) -> None:
    n = _failures.get((group_id, start_id), (0, 0.0))[0] + 1
    delay = min(BACKOFF_S * 2 ** (n - 1), BACKOFF_MAX_S)
    _failures[(group_id, start_id)] = (n, time.monotonic() + delay)


def backed_off(group_id: int, start_id: int) -> bool:
    entry = _failures.get((group_id, start_id))
    return entry is not None and entry[1] > time.monotonic()


async def backfill_digests(
    session: AsyncSession,
    group_id: int,
    *,
    min_id: int | None = None,
    max_id: int | None = None,
    timeout: float | None = None,
    budget: float | None = None,
    concurrency: int = CONCURRENCY,
    skip_backed_off: bool = False,
) -> int:
    """Digest every full, undigested chunk in the group (optionally only chunks
    inside [min_id, max_id]) with bounded concurrency; returns digests created.

    `timeout` caps each LLM call and `budget` the whole run (unfinished calls are
    cancelled once it passes). A chunk that fails stays undigested and is backed off
    exponentially; `skip_backed_off` (background runs) skips chunks still waiting."""
    chunks = await pending_chunks(session, group_id, min_id=min_id, max_id=max_id)
    if skip_backed_off:
        chunks = [c for c in chunks if not backed_off(group_id, c.start_id)]
    if not chunks:
        return 0
    loaded = [
        await fetch_lines(
            session,
            lines_query(group_id)
            .where(Message.id.between(c.start_id, c.end_id))
            .order_by(Message.id),
        )
        for c in chunks
    ]
    sem = asyncio.Semaphore(concurrency)

    async def run(lines: list[Line]) -> tuple[list[Line], dict[str, Any] | None]:
        async with sem:
            try:
                return lines, await summarize(lines, timeout=timeout)
            except Exception as exc:
                log.warning(
                    "digest failed: group %s #%s: %r", group_id, lines[0].id, exc
                )
                _record_failure(group_id, lines[0].id)
                return lines, None

    loop = asyncio.get_running_loop()
    deadline = None if budget is None else loop.time() + budget
    pending = {asyncio.ensure_future(run(lines)) for lines in loaded}
    created = 0
    try:
        while pending:
            wait = None if deadline is None else max(deadline - loop.time(), 0)
            done, pending = await asyncio.wait(
                pending, timeout=wait, return_when=asyncio.FIRST_COMPLETED
            )
            if not done:
                log.warning(
                    "digest budget spent: group %s, %d left", group_id, len(pending)
                )
                break
            for task in done:
                lines, digest = task.result()
                if digest is not None:
                    _failures.pop((group_id, lines[0].id), None)
                    created += await _store(session, group_id, lines, digest)
    finally:
        for task in pending:
            task.cancel()
    return created


_active: set[int] = set()
_again: set[int] = set()
_tasks: set[asyncio.Task[None]] = set()


def schedule_digest(group_id: int) -> None:
    """Called after each committed message insert; digests a chunk once it fills.

    Never blocks: at most one background task per group; calls that arrive while it
    runs make it loop once more instead of starting another.
    """
    if group_id in _active:
        _again.add(group_id)
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    _active.add(group_id)
    task = loop.create_task(_digest_group(group_id))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def _digest_group(group_id: int) -> None:
    try:
        while True:
            _again.discard(group_id)
            async with db.SessionLocal() as session:
                n = await backfill_digests(session, group_id, skip_backed_off=True)
            if n:
                log.info("digested %d chunk(s) in group %s", n, group_id)
            if group_id not in _again:
                return
    except Exception:
        log.exception("background digest failed for group %s", group_id)
    finally:
        _active.discard(group_id)


async def drain() -> None:
    """Wait for scheduled background digests to finish (tests, scripts)."""
    while _tasks:
        await asyncio.gather(*_tasks, return_exceptions=True)
