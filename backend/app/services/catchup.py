"""Feature 3: catch-up (reduce chunk digests + undigested tail, stream bullets).

A range is the member's unread messages: after `since_message_id` (default: their
last_read_message_id), or from the first message at/after joined_at when they never
read. Digests fully inside the range are reduced together with the raw messages they
don't cover; the model writes NDJSON bullets, parsed and emitted as each completes.
Nothing here touches read state.
"""

import asyncio
import json
import logging
import re
import time
from bisect import bisect_left
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel
from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.core import db
from app.models import ChunkDigest, Glossary, Membership, Message
from app.services import digests, llm
from app.services.digests import Line, as_id, local, render_lines
from app.services.messages import require_member, require_message

log = logging.getLogger(__name__)

RAW_DIRECT_LIMIT = 250  # raw lines sent as-is; older uncovered ones become a GAP
MAX_CONTEXT_CHARS = 60_000  # oldest blocks are dropped past this
TAP_DIGEST_BUDGET_S = 10.0  # total time for digesting missing chunks at tap time
TAP_DIGEST_CONCURRENCY = 12
FIRST_BULLET_S = 7.0  # no bullet by then: race a one-shot JSON call against the stream
FALLBACK_TIMEOUT_S = 12.0
STREAM_IDLE_S = 10.0  # a stall this long after the first bullet ends the list
REDUCE_TIMEOUT_S = 25.0
KEEPALIVE_S = 5.0  # SSE comment while nothing else is sent
SECTION_LIMITS = {"happened": 6, "decisions": 4, "open": 4}
SECTION_ALIASES = {
    "happened": "happened",
    "events": "happened",
    "event": "happened",
    "decisions": "decisions",
    "decision": "decisions",
    "decided": "decisions",
    "open": "open",
    "open_questions": "open",
    "open_question": "open",
    "questions": "open",
}
MAX_TERMS = 5
ASK_FTS_LIMIT = 40
ASK_RECENT_LIMIT = 15
ASK_DIGEST_LIMIT = 8

BULLET_RULES = """- Write 3-6 "happened" bullets, then "decisions" (0-4), then "open"
  (0-3: unanswered questions, unresolved plans).
- Situational, not encyclopedic: what the reader needs to jump back into the chat now.
  Weight the newest messages highest; compress or drop old background.
- One short sentence per bullet (max 25 words), casual plain English, name people.
- Use relative times ("last night", "this morning") from the Now line.
- When a bullet uses a term listed under GLOSSARY, add a 2-4 word gloss in parentheses.
- start_message_id/end_message_id must be ids from the input ([#id]), start <= end,
  pointing at where it happened."""

REDUCE_INTRO = """You write a catch-up for a member who missed part of a group chat.
The input is chronological: DIGEST blocks summarize 100 messages each; RAW blocks are
the actual messages, `[#<id> <HH:MM> <name>] text`; GAP blocks mark messages that
could not be included (don't guess what happened there)."""

REDUCE_SYSTEM = f"""{REDUCE_INTRO}
Output NDJSON: one JSON object per line and nothing else (no prose, no code fences, no
array), for example:
{{"type":"bullet","section":"happened","text":"...","start_message_id":1,"end_message_id":9}}
{BULLET_RULES}"""

REDUCE_SYSTEM_JSON = f"""{REDUCE_INTRO}
Return only a JSON object: {{"bullets": [{{"section": "happened" | "decisions" | "open",
"text": str, "start_message_id": int, "end_message_id": int}}]}}
{BULLET_RULES}"""

ASK_SYSTEM = """You answer a member's follow-up question about group chat messages they
missed, using only the provided digests and messages ([#id] are message ids).
Return only a JSON object: {"answer": str, "sources": [{"start_message_id": int,
"end_message_id": int}]}
- answer: at most 3 short sentences, casual and direct. If the chat doesn't say, say so.
- sources: 1-3 id ranges from the input that support the answer ([] if none)."""


@dataclass(frozen=True)
class CatchupRange:
    group_id: int
    user_id: str
    joined_at: datetime
    last_read_message_id: int | None
    since_message_id: int | None  # as reported in meta/preview
    lo: int | None  # first message id in the range (inclusive)
    until: int | None  # latest message id (inclusive)
    unread_count: int

    @property
    def empty(self) -> bool:
        return self.lo is None or self.until is None or self.lo > self.until

    def clamp(self, value: int) -> int:
        assert self.lo is not None and self.until is not None
        return min(max(value, self.lo), self.until)


async def resolve_range(
    session: AsyncSession, group_id: int, user_id: str, since: int | None = None
) -> CatchupRange:
    """Range for a member: (since, latest], defaulting since to last_read, else every
    message at/after joined_at. Raises 403/404 like the other group routes."""
    m: Membership = await require_member(session, group_id, user_id)
    if since is not None:
        await require_message(session, group_id, since)
    else:
        since = m.last_read_message_id
    after = Message.id > since if since is not None else Message.ts >= m.joined_at
    others = or_(Message.sender_id.is_(None), Message.sender_id != user_id)
    lo, hi, unread = (
        await session.execute(
            select(
                func.min(Message.id),
                func.max(Message.id),
                func.count().filter(others),
            ).where(Message.group_id == group_id, after)
        )
    ).one()
    if hi is None:
        latest = await crud.latest_message(session, group_id)
        hi = latest.id if latest else since
    return CatchupRange(
        group_id=group_id,
        user_id=user_id,
        joined_at=m.joined_at,
        last_read_message_id=m.last_read_message_id,
        since_message_id=since if since is not None else lo,
        lo=lo,
        until=hi,
        unread_count=unread or 0,
    )


# Context: digests fully inside the range + raw messages they don't cover.


@dataclass(frozen=True)
class Block:
    start: int
    end: int
    text: str


def _span(item: dict[str, Any]) -> str:
    return f"[#{item['start_message_id']}-#{item['end_message_id']}]"


def digest_block(start: int, end: int, ts: datetime, count: int, d: dict) -> Block:
    labels = (
        ("events", "happened"),
        ("decisions", "decided"),
        ("open_questions", "open"),
    )
    lines = [
        f"DIGEST #{start}-#{end} ({local(ts):%a %b} {local(ts).day}, {count} msgs)"
    ]
    for key, label in labels:
        lines += [f"- {label}: {i['text']} {_span(i)}" for i in d.get(key) or []]
    extras = []
    if d.get("terms"):
        extras.append("terms: " + ", ".join(d["terms"]))
    if d.get("mood"):
        extras.append(f"mood: {d['mood']}")
    if extras:
        lines.append("; ".join(extras))
    return Block(start, end, "\n".join(lines))


def raw_block(lines: list[Line]) -> Block:
    head = f"RAW #{lines[0].id}-#{lines[-1].id} ({len(lines)} msgs)"
    return Block(lines[0].id, lines[-1].id, head + "\n" + render_lines(lines))


def _in_range(rng: CatchupRange) -> Any:
    return and_(
        Message.group_id == rng.group_id,
        Message.id >= rng.lo,
        Message.id <= rng.until,
    )


def _digests_inside(rng: CatchupRange) -> Any:
    return and_(
        ChunkDigest.group_id == rng.group_id,
        ChunkDigest.start_message_id >= rng.lo,
        ChunkDigest.end_message_id <= rng.until,
    )


async def _load(
    session: AsyncSession, rng: CatchupRange
) -> tuple[list[ChunkDigest], list[Line]]:
    rows = list(
        await session.scalars(
            select(ChunkDigest)
            .where(_digests_inside(rng))
            .order_by(ChunkDigest.start_message_id)
        )
    )
    covered = exists().where(
        _digests_inside(rng),
        Message.id.between(ChunkDigest.start_message_id, ChunkDigest.end_message_id),
    )
    raw = await digests.fetch_lines(
        session,
        digests.lines_query(rng.group_id)
        .where(_in_range(rng), ~covered)
        .order_by(Message.id),
    )
    return rows, raw


def _raw_runs(raw: list[Line], rows: list[ChunkDigest]) -> list[list[Line]]:
    """Split raw lines into runs not interrupted by a digest."""
    ends = [d.end_message_id for d in rows]
    runs: dict[int, list[Line]] = {}
    for line in raw:
        runs.setdefault(bisect_left(ends, line.id), []).append(line)
    return list(runs.values())


def gap_block(lines: list[Line]) -> Block:
    head = f"GAP #{lines[0].id}-#{lines[-1].id} ({len(lines)} msgs not included)"
    return Block(lines[0].id, lines[-1].id, head)


def raw_blocks(raw: list[Line], rows: list[ChunkDigest]) -> list[Block]:
    """One RAW block per run between digests, keeping only the newest
    RAW_DIRECT_LIMIT lines; older uncovered lines become GAP blocks."""
    blocks: list[Block] = []
    room = RAW_DIRECT_LIMIT
    for run in reversed(_raw_runs(raw, rows)):
        keep = run[len(run) - min(room, len(run)) :]
        room -= len(keep)
        if keep:
            blocks.append(raw_block(keep))
        if len(keep) < len(run):
            blocks.append(gap_block(run[: len(run) - len(keep)]))
    return blocks


async def gather_blocks(session: AsyncSession, rng: CatchupRange) -> list[Block]:
    rows, raw = await _load(session, rng)
    if len(raw) > RAW_DIRECT_LIMIT:  # digests missing: digest the range's chunks now
        await digests.backfill_digests(
            session,
            rng.group_id,
            min_id=rng.lo,
            max_id=rng.until,
            budget=TAP_DIGEST_BUDGET_S,
            concurrency=TAP_DIGEST_CONCURRENCY,
        )
        rows, raw = await _load(session, rng)
        if len(raw) > RAW_DIRECT_LIMIT:  # finish the rest in the background
            digests.schedule_digest(rng.group_id)
    blocks = [
        digest_block(
            d.start_message_id, d.end_message_id, d.start_ts, d.message_count, d.digest
        )
        for d in rows
    ]
    blocks += raw_blocks(raw, rows)
    blocks.sort(key=lambda b: b.start)
    while len(blocks) > 1 and sum(len(b.text) for b in blocks) > MAX_CONTEXT_CHARS:
        blocks.pop(0)
    return blocks


# Terms the member missed: glossary terms used in the range, set before they joined.


def _term_pattern(entry: Glossary) -> str:
    names = sorted({entry.term, *entry.aliases}, key=len, reverse=True)
    return r"\m(?:" + "|".join(re.escape(n) for n in names if n) + r")\M"


async def missed_terms(
    session: AsyncSession, rng: CatchupRange
) -> list[schemas.CatchupTerm]:
    if rng.empty:
        return []
    origin = func.coalesce(Glossary.last_explained_ts, Glossary.first_seen_ts)
    entries = list(
        await session.scalars(
            select(Glossary)
            .where(Glossary.group_id == rng.group_id, origin < rng.joined_at)
            .order_by(Glossary.id)
        )
    )
    if not entries:
        return []
    counts = (
        await session.execute(
            select(
                *(
                    func.count().filter(
                        Message.text.regexp_match(_term_pattern(e), "i")
                    )
                    for e in entries
                )
            ).where(_in_range(rng))
        )
    ).one()
    ranked = sorted(
        (pair for pair in zip(counts, entries, strict=True) if pair[0] > 0),
        key=lambda pair: -pair[0],
    )
    return [
        schemas.CatchupTerm(term=e.term, glossary_id=e.id, meaning=e.meaning)
        for _, e in ranked[:MAX_TERMS]
    ]


# Reduce: NDJSON bullets parsed as they stream.


class JsonObjectStream:
    """Incrementally pull complete top-level JSON objects out of streamed text.

    Handles NDJSON split anywhere across deltas, several objects on one line, and
    stray prose or code fences between objects (ignored).
    """

    def __init__(self) -> None:
        self.buf = ""
        self.pos = 0
        self.depth = 0
        self.start = 0
        self.in_str = False
        self.esc = False

    def feed(self, delta: str) -> list[dict[str, Any]]:
        self.buf += delta
        out: list[dict[str, Any]] = []
        while self.pos < len(self.buf):
            c = self.buf[self.pos]
            if self.in_str:
                if self.esc:
                    self.esc = False
                elif c == "\\":
                    self.esc = True
                elif c == '"':
                    self.in_str = False
            elif c == '"' and self.depth:
                self.in_str = True
            elif c == "{":
                if not self.depth:
                    self.start = self.pos
                self.depth += 1
            elif c == "}" and self.depth:
                self.depth -= 1
                if not self.depth:
                    try:
                        obj = json.loads(self.buf[self.start : self.pos + 1])
                    except json.JSONDecodeError:
                        obj = None
                    if isinstance(obj, dict):
                        out.append(obj)
                    self.buf, self.pos = self.buf[self.pos + 1 :], -1
            self.pos += 1
        if not self.depth:
            self.buf, self.pos = "", 0
        return out


class BulletFilter:
    """Validate model bullets: known section, text, ids clamped into the range,
    per-section limits, no duplicates."""

    def __init__(self, rng: CatchupRange) -> None:
        self.rng = rng
        self.counts: dict[str, int] = {}
        self.seen: set[str] = set()

    def accept(self, obj: dict[str, Any]) -> Iterator[schemas.CatchupBullet]:
        if "text" not in obj:  # wrapper like {"bullets": [...]} or {"happened": [...]}
            for key, value in obj.items():
                for item in value if isinstance(value, list) else []:
                    if isinstance(item, dict):
                        hint = {"section": key} if key in SECTION_ALIASES else {}
                        yield from self.accept(hint | item)
            return
        if obj.get("type", "bullet") != "bullet":
            return
        section = SECTION_ALIASES.get(str(obj.get("section") or "happened").lower())
        body = obj.get("text")
        if section is None or not isinstance(body, str) or not body.strip():
            return
        body = body.strip()
        if (
            body.lower() in self.seen
            or self.counts.get(section, 0) >= (SECTION_LIMITS[section])
        ):
            return
        assert self.rng.until is not None
        start, end = (
            as_id(obj.get("start_message_id")),
            as_id(obj.get("end_message_id")),
        )
        start = next((i for i in (start, end) if i is not None), self.rng.until)
        end = end if end is not None else start
        start, end = sorted((self.rng.clamp(start), self.rng.clamp(end)))
        self.seen.add(body.lower())
        self.counts[section] = self.counts.get(section, 0) + 1
        yield schemas.CatchupBullet(
            section=section, text=body, start_message_id=start, end_message_id=end
        )


def reduce_prompt(
    rng: CatchupRange,
    reader: str,
    blocks: list[Block],
    terms: list[schemas.CatchupTerm],
) -> str:
    now = local(datetime.now(UTC))
    joined = local(rng.joined_at)
    read = (
        f"message #{rng.last_read_message_id}"
        if rng.last_read_message_id is not None
        else "never"
    )
    parts = [
        f"Reader: {reader} (joined {joined:%a %b} {joined.day}; last read: {read})",
        f"Now: {now:%a %b} {now.day} {now:%H:%M}",
        f"Range: #{rng.lo}-#{rng.until}, {rng.unread_count} unread messages",
    ]
    if terms:
        parts.append("GLOSSARY (inside terms the reader missed):")
        parts += [f"- {t.term}: {t.meaning}" for t in terms]
    parts.append("CHAT:")
    parts += [b.text for b in blocks]
    return "\n".join(parts)


async def reduce_bullets(
    rng: CatchupRange, prompt: str
) -> AsyncIterator[schemas.CatchupBullet]:
    """Stream NDJSON bullets as they complete.

    If no bullet arrives within FIRST_BULLET_S (or the stream fails first), a one-shot
    JSON call races the stream and whichever yields bullets first wins. A stall or
    failure after the first bullet ends the list instead of failing it.
    """
    events: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()

    async def pump() -> None:
        parser = JsonObjectStream()
        try:
            async for delta in llm.stream_text(REDUCE_SYSTEM, prompt, max_tokens=3000):
                events.put_nowait(("stream", parser.feed(delta)))
            events.put_nowait(("stream_end", None))
        except Exception as exc:
            events.put_nowait(("stream_end", exc))

    async def one_shot() -> None:
        try:
            call = llm.complete_json(REDUCE_SYSTEM_JSON, prompt, max_tokens=3000)
            events.put_nowait(
                ("fallback", [await asyncio.wait_for(call, FALLBACK_TIMEOUT_S)])
            )
        except Exception as exc:
            events.put_nowait(("fallback_end", exc))

    loop = asyncio.get_running_loop()
    started = loop.time()
    filt, emitted = BulletFilter(rng), 0
    tasks = [asyncio.create_task(pump())]
    stream_done = fallback_done = False
    fallback_error: Exception | None = None
    try:
        while True:
            if emitted:
                deadline = min(loop.time() + STREAM_IDLE_S, started + REDUCE_TIMEOUT_S)
            elif len(tasks) == 1:
                deadline = started + FIRST_BULLET_S
            else:
                deadline = started + REDUCE_TIMEOUT_S
            try:
                async with asyncio.timeout_at(deadline):
                    kind, value = await events.get()
            except TimeoutError:
                if emitted:
                    log.warning("catch-up stream stalled after %d bullets", emitted)
                    return
                if len(tasks) == 1:
                    log.warning("no catch-up bullet yet; racing a one-shot call")
                    tasks.append(asyncio.create_task(one_shot()))
                    continue
                raise
            if kind == "stream" or (kind == "fallback" and not emitted):
                for obj in value:
                    for bullet in filt.accept(obj):
                        if kind == "stream" and not emitted:
                            for task in tasks[1:]:  # the stream won
                                task.cancel()
                        emitted += 1
                        yield bullet
                if kind == "stream":
                    continue
                if emitted:  # the one-shot call won
                    return
                kind, value = "fallback_end", None
            if kind == "stream_end":
                if value is not None:
                    log.warning("catch-up stream failed: %r", value)
                if emitted:
                    return
                stream_done = True
                if len(tasks) == 1:
                    tasks.append(asyncio.create_task(one_shot()))
            elif kind == "fallback_end":
                fallback_done, fallback_error = True, value
            if stream_done and fallback_done:
                if fallback_error is not None:
                    raise fallback_error
                return  # both finished without bullets
    finally:
        for task in tasks:
            task.cancel()


async def run_catchup(rng: CatchupRange) -> AsyncIterator[tuple[str, BaseModel]]:
    """The whole pipeline as (event, payload) pairs: meta, bullet*, term*, done."""
    started = time.monotonic()
    yield (
        "meta",
        schemas.CatchupMeta(
            unread_count=rng.unread_count,
            since_message_id=rng.since_message_id or 0,
            until_message_id=rng.until or 0,
        ),
    )
    terms: list[schemas.CatchupTerm] = []
    if not rng.empty and rng.unread_count:
        async with db.SessionLocal() as session:
            blocks = await gather_blocks(session, rng)
            terms = await missed_terms(session, rng)
            user = await crud.get_user(session, rng.user_id)
        reader = user.display_name if user else rng.user_id
        async for bullet in reduce_bullets(
            rng, reduce_prompt(rng, reader, blocks, terms)
        ):
            yield "bullet", bullet
    for term in terms:
        yield "term", term
    elapsed = int((time.monotonic() - started) * 1000)
    yield "done", schemas.CatchupDone(elapsed_ms=elapsed)


def sse_frame(event: str, payload: BaseModel) -> str:
    return f"event: {event}\ndata: {payload.model_dump_json()}\n\n"


async def sse(rng: CatchupRange) -> AsyncIterator[str]:
    """SSE frames, with `: ping` comments while waiting. The pipeline runs in its own
    task so a disconnecting client just cancels it."""
    frames: asyncio.Queue[str | None] = asyncio.Queue()

    async def produce() -> None:
        try:
            async for event, payload in run_catchup(rng):
                frames.put_nowait(sse_frame(event, payload))
        except Exception:
            log.exception("catch-up failed for group %s", rng.group_id)
            msg = "Couldn't build the catch-up right now."
            frames.put_nowait(sse_frame("error", schemas.CatchupError(message=msg)))
        frames.put_nowait(None)

    task = asyncio.create_task(produce())
    try:
        while True:
            try:
                frame = await asyncio.wait_for(frames.get(), KEEPALIVE_S)
            except TimeoutError:
                yield ": ping\n\n"
                continue
            if frame is None:
                return
            yield frame
    finally:
        task.cancel()


async def collect(rng: CatchupRange) -> schemas.CatchupResult:
    result = schemas.CatchupResult(
        unread_count=rng.unread_count,
        since_message_id=rng.since_message_id or 0,
        until_message_id=rng.until or 0,
        bullets=[],
        terms=[],
    )
    async for event, payload in run_catchup(rng):
        if isinstance(payload, schemas.CatchupBullet):
            result.bullets.append(payload)
        elif isinstance(payload, schemas.CatchupTerm):
            result.terms.append(payload)
    return result


# Follow-up questions, grounded in the same range.

_WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9']*")
_STOP = {"the", "and", "what", "who", "did", "does", "about", "with", "they", "was"}


def _keywords(question: str) -> list[str]:
    words = [w.lower() for w in _WORD.findall(question)]
    return [w for w in words if len(w) > 2 and w not in _STOP]


async def ask(
    session: AsyncSession, rng: CatchupRange, question: str
) -> schemas.CatchupAskResponse:
    if rng.empty:
        return schemas.CatchupAskResponse(
            answer="There's nothing new in this chat since you last read it.",
            sources=[],
        )
    keywords = _keywords(question)
    rows = list(
        await session.scalars(
            select(ChunkDigest)
            .where(_digests_inside(rng))
            .order_by(ChunkDigest.start_message_id)
        )
    )
    if len(rows) > ASK_DIGEST_LIMIT:
        scored = [
            (sum(json.dumps(d.digest).lower().count(k) for k in keywords), i)
            for i, d in enumerate(rows)
        ]
        keep = sorted(scored, reverse=True)[:ASK_DIGEST_LIMIT]
        rows = [rows[i] for i in sorted(i for _, i in keep)]

    lines: dict[int, Line] = {}
    if keywords:
        query = func.websearch_to_tsquery("english", " or ".join(keywords))
        hits = await digests.fetch_lines(
            session,
            digests.lines_query(rng.group_id)
            .where(_in_range(rng), Message.tsv.bool_op("@@")(query))
            .order_by(func.ts_rank(Message.tsv, query).desc(), Message.id.desc())
            .limit(ASK_FTS_LIMIT),
        )
        lines |= {line.id: line for line in hits}
    recent = await digests.fetch_lines(
        session,
        digests.lines_query(rng.group_id)
        .where(_in_range(rng))
        .order_by(Message.id.desc())
        .limit(ASK_RECENT_LIMIT),
    )
    lines |= {line.id: line for line in recent}

    blocks = [
        digest_block(
            d.start_message_id, d.end_message_id, d.start_ts, d.message_count, d.digest
        )
        for d in rows
    ]
    parts = [b.text for b in blocks]
    if lines:
        parts += ["MESSAGES:", render_lines(sorted(lines.values(), key=lambda x: x.id))]
    prompt = "\n".join([f"Question: {question}", *parts])
    data = await llm.complete_json(ASK_SYSTEM, prompt, max_tokens=3000)

    answer = data.get("answer")
    sources: list[schemas.CatchupSource] = []
    raw_sources = data.get("sources")
    for item in raw_sources if isinstance(raw_sources, list) else []:
        if not isinstance(item, dict):
            continue
        assert rng.lo is not None and rng.until is not None
        span = digests.clamp_span(item, rng.lo, rng.until)
        source = span and schemas.CatchupSource(
            start_message_id=span[0], end_message_id=span[1]
        )
        if source and source not in sources:
            sources.append(source)
    return schemas.CatchupAskResponse(
        answer=answer.strip()
        if isinstance(answer, str) and answer.strip()
        else "I couldn't find that in the messages you missed.",
        sources=sources[:3],
    )
