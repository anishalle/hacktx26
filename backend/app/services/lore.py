"""Feature 6: Lore, a group's kept moments.

A lore entry is a moment that happened (title, short story, who was there) with its
evidence: message ids (photos are messages too) and call replay ids. Detection only
suggests; a member keeps (first tap wins) or dismisses. Backfill keeps the strongest
moments of existing history automatically.

Chat detection: Muse reads raw lines (`[#id HH:MM name] text`, photos as `[photo: ...]`)
and returns moments with message ids from those lines only. Backfill walks the whole
history in DIGEST_CHUNK_SIZE chunks; live detection (`schedule_detect`) looks at the
messages since the last scan once a trigger fires (a burst, a photo cluster, a reaction
pile). A candidate whose embedding matches existing lore is attached to it instead of
duplicating it; related lore is the nearest kept lore by embedding.

Call replays live in app/services/replays.py and land here as `source="call"` lore.
Background work opens its own session via `app.core.db.SessionLocal()`.
"""

import asyncio
import logging
import math
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.core import db
from app.core.config import settings
from app.models import Lore, LoreReplay, Membership, Message, Reaction, User
from app.services import embeddings, llm, nudge
from app.services.digests import Line, as_id, fetch_lines, lines_query, render_lines
from app.services.messages import require_group, require_member
from app.services.realtime import broadcast_group, hub

log = logging.getLogger(__name__)

KEEP_SCORE = 0.6  # backfill keeps candidates at least this memorable
BACKFILL_KEEP = 8  # ... and at most this many per group
SUGGEST_SCORE = 0.6  # live detection suggests at least this memorable
MERGE_SIMILARITY = 0.86  # a candidate this close to existing lore is attached to it
MAX_KEY_MESSAGES = 8
CONCURRENCY = 6
# live triggers on messages since the last scan
BURST_MESSAGES = 30
PHOTO_CLUSTER = 2
REACTION_PILE = 3
SCAN_CONTEXT = 10  # lines before the new ones, for context
SCAN_MAX_LINES = 150
RELATED_LIMIT = 6
FEED_MAX = 50

DETECT_SYSTEM = """You curate a group chat's "lore": the moments its members will want \
to look back on. Input lines look like `[#<message id> <HH:MM> <name>] text` under \
`--- <day> ---` headers; photos appear as `[photo: <description>] <caption>`.
Pick moments that matter to this group: an inside joke or nickname being born, a funny \
incident, a trip, party or game, drama, big news, a plan that became a tradition. Skip \
logistics, small talk and anything only one person cared about.
Use only what the lines say; never invent events, people or details.
Return only JSON: {"moments": [{"title": str, "story": str, "start_message_id": int, \
"end_message_id": int, "key_message_ids": [int], "terms": [str], "score": number}]}
- title: at most 60 characters, specific and catchy ("The Incident: Mike's ramen fire \
alarm"), no quotes or emoji.
- story: 1-3 plain sentences a newcomer understands: what happened and why it stuck.
- key_message_ids: up to 8 ids from the input that tell the story (include its photos).
- terms: inside terms or nicknames involved, spelled as in the chat.
- score: 0-1, how memorable this is to the group (logistics ~0.1, a legendary \
night ~0.9).
Return {"moments": []} when nothing qualifies."""


# ------------------------------------------------------------------- views


async def _users(session: AsyncSession, ids: list[str]) -> dict[str, User]:
    if not ids:
        return {}
    rows = await session.scalars(select(User).where(User.id.in_(ids)))
    return {u.id: u for u in rows}


async def _messages(session: AsyncSession, ids: list[int]) -> list[Message]:
    if not ids:
        return []
    rows = await session.scalars(select(Message).where(Message.id.in_(ids)))
    return sorted(rows, key=lambda m: m.id)


async def _replays(session: AsyncSession, ids: list[int]) -> list[LoreReplay]:
    if not ids:
        return []
    rows = await session.scalars(select(LoreReplay).where(LoreReplay.id.in_(ids)))
    return sorted(rows, key=lambda r: r.started_at)


def replay_view(r: LoreReplay) -> schemas.LoreReplay:
    return schemas.LoreReplay(
        id=r.id,
        call_id=r.call_id,
        audio_url=schemas.media_url(r.audio_path),
        duration_ms=r.duration_ms,
        started_at=r.started_at,
        captions=[schemas.LoreCaption(**c) for c in r.captions],
    )


async def view(
    session: AsyncSession, lore: Lore, viewer_id: str | None = None
) -> schemas.Lore:
    group = await require_group(session, lore.group_id)
    messages = await _messages(session, list(lore.message_ids))
    photos = [m for m in messages if m.kind == "photo"]
    replays = await _replays(session, list(lore.replay_ids))
    users = await _users(
        session, [*lore.people, *([lore.kept_by] if lore.kept_by else [])]
    )
    index = await nudge.glossary_index(session, lore.group_id)
    return schemas.Lore(
        id=lore.id,
        group_id=lore.group_id,
        group_name=(await crud.group_view(session, group, viewer_id)).name,
        title=lore.title,
        story=lore.story,
        status=lore.status,  # type: ignore[arg-type]
        source=lore.source,  # type: ignore[arg-type]
        call_id=lore.call_id,
        started_at=lore.started_at,
        ended_at=lore.ended_at,
        people=[
            schemas.User.model_validate(users[p]) for p in lore.people if p in users
        ],
        terms=[
            schemas.LoreTerm(
                term=t, glossary_id=(k.id if (k := index.resolve(t)) else None)
            )
            for t in lore.terms
        ],
        cover=schemas.LoreCover(
            photo=schemas.Message.model_validate(photos[0]) if photos else None,
            replay=replay_view(replays[0]) if replays and not photos else None,
        ),
        anchor_message_id=lore.anchor_message_id,
        message_count=len(messages),
        photo_count=len(photos),
        replay_count=len(replays),
        kept_by=schemas.User.model_validate(users[lore.kept_by])
        if lore.kept_by in users
        else None,
        kept_at=lore.kept_at,
    )


async def related(session: AsyncSession, lore: Lore, limit: int = RELATED_LIMIT):
    stmt = select(Lore).where(
        Lore.group_id == lore.group_id, Lore.status == "kept", Lore.id != lore.id
    )
    if lore.embedding is not None:
        stmt = stmt.where(Lore.embedding.is_not(None)).order_by(
            Lore.embedding.cosine_distance(lore.embedding)
        )
    else:
        stmt = stmt.order_by(Lore.ended_at.desc())
    return list(await session.scalars(stmt.limit(limit)))


async def detail(
    session: AsyncSession, lore_id: int, user_id: str
) -> schemas.LoreDetail:
    lore = await _require(session, lore_id, user_id)
    messages = await _messages(session, list(lore.message_ids))
    base = await view(session, lore, user_id)
    return schemas.LoreDetail(
        **base.model_dump(),
        messages=[schemas.Message.model_validate(m) for m in messages],
        photos=[
            schemas.Message.model_validate(m) for m in messages if m.kind == "photo"
        ],
        replays=[
            replay_view(r) for r in await _replays(session, list(lore.replay_ids))
        ],
        related=[await view(session, r, user_id) for r in await related(session, lore)],
    )


async def _require(session: AsyncSession, lore_id: int, user_id: str) -> Lore:
    lore = await session.get(Lore, lore_id)
    if lore is None:
        raise HTTPException(404, "Lore not found")
    await require_member(session, lore.group_id, user_id)
    return lore


def _cursor(lore: Lore) -> str:
    return f"{lore.ended_at.timestamp():.6f}:{lore.id}"


async def feed(
    session: AsyncSession,
    user_id: str,
    group_id: int | None = None,
    cursor: str | None = None,
    limit: int = 20,
) -> schemas.LoreFeed:
    if await crud.get_user(session, user_id) is None:
        raise HTTPException(404, "User not found")
    groups = select(Membership.group_id).where(Membership.user_id == user_id)
    stmt = select(Lore).where(Lore.status == "kept", Lore.group_id.in_(groups))
    if group_id is not None:
        stmt = stmt.where(Lore.group_id == group_id)
    if cursor:
        try:
            ts, lid = cursor.split(":")
            at = datetime.fromtimestamp(float(ts), UTC)
            stmt = stmt.where(
                or_(Lore.ended_at < at, (Lore.ended_at == at) & (Lore.id < int(lid)))
            )
        except ValueError:
            raise HTTPException(422, "Bad cursor") from None
    limit = max(1, min(limit, FEED_MAX))
    rows = list(
        await session.scalars(
            stmt.order_by(Lore.ended_at.desc(), Lore.id.desc()).limit(limit + 1)
        )
    )
    more = len(rows) > limit
    rows = rows[:limit]
    return schemas.LoreFeed(
        items=[await view(session, r, user_id) for r in rows],
        next_cursor=_cursor(rows[-1]) if more and rows else None,
    )


async def suggestions(
    session: AsyncSession, group_id: int, user_id: str
) -> list[schemas.Lore]:
    await require_member(session, group_id, user_id)
    rows = await session.scalars(
        select(Lore)
        .where(
            Lore.group_id == group_id,
            Lore.status == "suggested",
            Lore.source == "chat",
        )
        .order_by(Lore.id)
    )
    return [await view(session, r, user_id) for r in rows]


# ----------------------------------------------------------------- actions


async def _announce(
    session: AsyncSession, lore: Lore, user_ids: list[str] | None = None
):
    frame = await view(session, lore)
    if user_ids is None:
        await broadcast_group(session, lore.group_id, "lore.updated", frame)
    else:
        await hub.send(user_ids, "lore.updated", frame)


async def keep(session: AsyncSession, lore_id: int, user_id: str) -> schemas.Lore:
    """Suggested → kept, first tap wins. A call replay that matches existing kept lore
    is attached to it, and that lore is returned."""
    lore = await _require(session, lore_id, user_id)
    if lore.status == "kept":
        return await view(session, lore, user_id)
    if lore.status != "suggested":
        raise HTTPException(409, "This moment was already dismissed")
    target = None
    if lore.source == "call":
        target = await _similar(session, lore.group_id, lore.embedding, exclude=lore.id)
    if target is not None:
        target.replay_ids = [*target.replay_ids, *lore.replay_ids]
        target.people = list(dict.fromkeys([*target.people, *lore.people]))
        target.terms = list(dict.fromkeys([*target.terms, *lore.terms]))
        target.ended_at = max(target.ended_at, lore.ended_at)
        lore.status = "dismissed"  # folded into `target`
        await session.commit()
        await _announce(session, lore)
        await _announce(session, target)
        return await view(session, target, user_id)
    lore.status, lore.kept_by, lore.kept_at = "kept", user_id, datetime.now(UTC)
    await session.commit()
    await _announce(session, lore)
    return await view(session, lore, user_id)


async def dismiss(session: AsyncSession, lore_id: int, user_id: str) -> schemas.Lore:
    lore = await _require(session, lore_id, user_id)
    if lore.status == "suggested":
        lore.status = "dismissed"
        await session.commit()
        await _announce(session, lore)
    return await view(session, lore, user_id)


async def remove(session: AsyncSession, lore_id: int, user_id: str) -> schemas.Lore:
    lore = await _require(session, lore_id, user_id)
    if lore.status != "kept":
        raise HTTPException(409, "Only kept lore can be removed")
    lore.status = "removed"
    await session.commit()
    await _announce(session, lore)
    return await view(session, lore, user_id)


async def for_explanation(
    session: AsyncSession, group_id: int, term: str | None, message_ids: list[int]
) -> list[schemas.Lore]:
    """Kept lore an explanation belongs to: same term, or one of its messages."""
    conds = []
    if term:
        conds.append(text(":term ILIKE ANY (lore.terms)").bindparams(term=term))
    ids = [i for i in message_ids if i]
    if ids:
        conds.append(Lore.message_ids.overlap(ids))
    if not conds:
        return []
    rows = await session.scalars(
        select(Lore)
        .where(Lore.group_id == group_id, Lore.status == "kept", or_(*conds))
        .order_by(Lore.score.desc(), Lore.id)
        .limit(2)
    )
    return [await view(session, r) for r in rows]


# --------------------------------------------------------------- detection


@dataclass
class Candidate:
    title: str
    story: str
    message_ids: list[int]
    terms: list[str]
    score: float
    start_id: int
    end_id: int
    people: list[str] = field(default_factory=list)
    started_at: datetime | None = None
    ended_at: datetime | None = None
    embedding: list[float] | None = None

    @property
    def text(self) -> str:
        return f"{self.title}. {self.story} {' '.join(self.terms)}".strip()


def _clean(raw: Any, lines: list[Line]) -> list[Candidate]:
    ids = {line.id for line in lines}
    order = [line.id for line in lines]
    out = []
    for m in raw if isinstance(raw, list) else []:
        if not isinstance(m, dict):
            continue
        title = " ".join(str(m.get("title") or "").split()).strip("\"'")[:80]
        story = " ".join(str(m.get("story") or "").split())[:600]
        key = [i for v in (m.get("key_message_ids") or []) if (i := as_id(v)) in ids]
        start, end = as_id(m.get("start_message_id")), as_id(m.get("end_message_id"))
        span = [
            i
            for i in order
            if start is not None and end is not None and start <= i <= end
        ]
        key = list(dict.fromkeys(key or span[-MAX_KEY_MESSAGES:]))[:MAX_KEY_MESSAGES]
        try:
            score = min(1.0, max(0.0, float(m.get("score") or 0)))
        except (TypeError, ValueError):
            score = 0.0
        if not title or not story or not key:
            continue
        terms = [
            " ".join(str(t).split())
            for t in (m.get("terms") or [])
            if isinstance(t, str) and t.strip()
        ][:6]
        out.append(
            Candidate(title, story, sorted(key), terms, score, min(key), max(key))
        )
    return out


async def _detect(lines: list[Line]) -> list[Candidate]:
    if not lines:
        return []
    try:
        data = await llm.complete_json(
            DETECT_SYSTEM, render_lines(lines), max_tokens=4000
        )
    except Exception as exc:
        log.warning("lore detection failed: %r", exc)
        return []
    return _clean(data.get("moments"), lines)


async def _fill(session: AsyncSession, group_id: int, c: Candidate) -> Candidate:
    """People, times and photos for a candidate, from its messages."""
    messages = await _messages(session, c.message_ids)
    photos = await session.scalars(
        select(Message.id).where(
            Message.group_id == group_id,
            Message.kind == "photo",
            Message.id.between(c.start_id, c.end_id),
        )
    )
    c.message_ids = sorted({*c.message_ids, *photos})
    c.people = list(dict.fromkeys(m.sender_id for m in messages if m.sender_id))
    if messages:
        c.started_at, c.ended_at = messages[0].ts, messages[-1].ts
    index = await nudge.glossary_index(session, group_id)
    found = [mt.term.term for m in messages for mt in index.find(m.text or "")]
    c.terms = list(dict.fromkeys([*c.terms, *found]))[:6]
    c.embedding = await embeddings.embed(c.text)
    return c


def _cosine(a: list[float], b: Any) -> float:
    b = list(b)
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)


async def _similar(
    session: AsyncSession, group_id: int, vector: Any, exclude: int | None = None
) -> Lore | None:
    """The kept lore this embedding matches closely enough to merge into."""
    if vector is None:
        return None
    stmt = select(Lore).where(
        Lore.group_id == group_id, Lore.status == "kept", Lore.embedding.is_not(None)
    )
    if exclude is not None:
        stmt = stmt.where(Lore.id != exclude)
    best = await session.scalar(
        stmt.order_by(Lore.embedding.cosine_distance(vector)).limit(1)
    )
    if best is None or _cosine(list(vector), best.embedding) < MERGE_SIMILARITY:
        return None
    return best


def _merge_into(target: Lore, c: Candidate) -> None:
    target.message_ids = sorted({*target.message_ids, *c.message_ids})
    target.people = list(dict.fromkeys([*target.people, *c.people]))
    target.terms = list(dict.fromkeys([*target.terms, *c.terms]))[:8]
    if c.started_at and c.started_at < target.started_at:
        target.started_at = c.started_at
    if c.ended_at and c.ended_at > target.ended_at:
        target.ended_at = c.ended_at


def _new(group_id: int, c: Candidate, status: str) -> Lore:
    now = datetime.now(UTC)
    return Lore(
        group_id=group_id,
        title=c.title,
        story=c.story,
        status=status,
        source="chat",
        started_at=c.started_at or now,
        ended_at=c.ended_at or now,
        people=c.people,
        terms=c.terms,
        message_ids=c.message_ids,
        replay_ids=[],
        anchor_message_id=c.end_id,
        score=c.score,
        embedding=c.embedding,
        kept_at=now if status == "kept" else None,
    )


async def backfill_group(
    session: AsyncSession, group_id: int, *, keep_top: int = BACKFILL_KEEP
) -> list[Lore]:
    """Detect moments over the whole history and keep the strongest automatically.
    Candidates matching each other (or existing kept lore) are merged."""
    lines = await fetch_lines(
        session,
        lines_query(group_id).where(Message.kind != "system").order_by(Message.id),
    )
    size = settings.DIGEST_CHUNK_SIZE
    chunks = [lines[i : i + size] for i in range(0, len(lines), size)]
    gate = asyncio.Semaphore(CONCURRENCY)

    async def run(chunk: list[Line]) -> list[Candidate]:
        async with gate:
            return await _detect(chunk)

    found = [c for batch in await asyncio.gather(*map(run, chunks)) for c in batch]
    found = [c for c in found if c.score >= KEEP_SCORE]
    found.sort(key=lambda c: -c.score)
    picked: list[Candidate] = []
    for c in found:
        await _fill(session, group_id, c)
        twin = next(
            (
                p
                for p in picked
                if c.embedding
                and p.embedding
                and _cosine(c.embedding, p.embedding) >= MERGE_SIMILARITY
            ),
            None,
        )
        if twin:
            twin.message_ids = sorted({*twin.message_ids, *c.message_ids})
            twin.people = list(dict.fromkeys([*twin.people, *c.people]))
            twin.terms = list(dict.fromkeys([*twin.terms, *c.terms]))[:8]
            continue
        if len(picked) < keep_top:
            picked.append(c)
    kept = []
    for c in picked:
        target = await _similar(session, group_id, c.embedding)
        if target is not None:
            _merge_into(target, c)
            kept.append(target)
        else:
            row = _new(group_id, c, "kept")
            session.add(row)
            kept.append(row)
    await session.commit()
    return kept


# live detection -----------------------------------------------------------

_last_scanned: dict[int, int] = {}
_active: set[int] = set()
_again: set[int] = set()
_tasks: set[asyncio.Task[None]] = set()


def schedule_detect(group_id: int) -> None:
    """Called after messages, photos and reactions; checks the triggers in the
    background (same one-task-per-group scheme as digests.schedule_digest)."""
    if group_id in _active:
        _again.add(group_id)
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    _active.add(group_id)
    task = loop.create_task(_detect_group(group_id))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def _detect_group(group_id: int) -> None:
    try:
        while True:
            _again.discard(group_id)
            async with db.SessionLocal() as session:
                await detect_recent(session, group_id)
            if group_id not in _again:
                return
    except Exception:
        log.exception("lore detection failed for group %s", group_id)
    finally:
        _active.discard(group_id)


async def _triggered(session: AsyncSession, group_id: int, after: int) -> bool:
    new = list(
        await session.execute(
            select(Message.id, Message.kind).where(
                Message.group_id == group_id, Message.id > after
            )
        )
    )
    if len(new) >= BURST_MESSAGES:
        return True
    if sum(kind == "photo" for _, kind in new) >= PHOTO_CLUSTER:
        return True
    piles = await session.scalar(
        select(func.count()).select_from(
            select(Reaction.message_id)
            .join(Message, Message.id == Reaction.message_id)
            .where(Message.group_id == group_id, Message.id > after)
            .group_by(Reaction.message_id)
            .having(func.count() >= REACTION_PILE)
            .subquery()
        )
    )
    return bool(piles)


async def detect_recent(session: AsyncSession, group_id: int) -> Lore | None:
    """If a trigger fired since the last scan, suggest (or attach) one moment."""
    latest = await session.scalar(
        select(func.max(Message.id)).where(Message.group_id == group_id)
    )
    if latest is None:
        return None
    if group_id not in _last_scanned:  # first look since startup: don't rescan history
        anchor = await session.scalar(
            select(func.max(Lore.anchor_message_id)).where(Lore.group_id == group_id)
        )
        _last_scanned[group_id] = anchor or latest
        if not anchor:
            return None
    after = _last_scanned[group_id]
    if latest <= after or not await _triggered(session, group_id, after):
        return None
    lines = await fetch_lines(
        session,
        lines_query(group_id)
        .where(Message.kind != "system", Message.id > after)
        .order_by(Message.id)
        .limit(SCAN_MAX_LINES),
    )
    context = await fetch_lines(
        session,
        lines_query(group_id)
        .where(Message.kind != "system", Message.id <= after)
        .order_by(Message.id.desc())
        .limit(SCAN_CONTEXT),
    )
    _last_scanned[group_id] = latest
    await session.commit()  # don't hold a pooled connection across the LLM call
    found = [
        c
        for c in await _detect([*reversed(context), *lines])
        if c.score >= SUGGEST_SCORE
    ]
    new_ids = {line.id for line in lines}
    found = [c for c in found if new_ids & set(c.message_ids)]
    if not found:
        return None
    c = await _fill(session, group_id, max(found, key=lambda c: c.score))
    target = await _similar(session, group_id, c.embedding)
    if target is not None:
        _merge_into(target, c)
        await session.commit()
        await _announce(session, target)
        return target
    row = _new(group_id, c, "suggested")
    session.add(row)
    await session.commit()
    await _announce(session, row)
    return row


async def drain() -> None:
    """Wait for scheduled detection to finish (tests, scripts)."""
    while _tasks:
        await asyncio.gather(*_tasks, return_exceptions=True)


def reset() -> None:
    """Forget scan positions (tests: ids repeat across databases)."""
    _last_scanned.clear()
