"""Feature 6: Lore, a group's kept moments.

A lore entry is a moment that happened (an AI title, who was there) with its evidence:
message ids (photos are messages too) and call replay ids. What a moment shows is its
events: each photo, each replay, or (when it has neither) its most-reacted message as a
quote, with the real lines people sent or said around it as snippets (`_events`,
deterministic, stored in `lore.events`). The title is the only model-written text the
API serves; the story is still generated and embedded (for dedupe) but never shipped.
Detection only suggests; a member keeps (first tap wins) or dismisses. Backfill keeps
the strongest moments of existing history automatically. Pins are per member.

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
import re
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from fastapi import HTTPException
from sqlalchemy import Float, and_, case, cast, delete, func, or_, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.core import db
from app.core.config import settings
from app.models import (
    Lore,
    LoreGame,
    LorePin,
    LoreReplay,
    Membership,
    Message,
    Reaction,
    User,
)
from app.services import embeddings, llm, nudge
from app.services.digests import Line, as_id, fetch_lines, lines_query, render_lines
from app.services.messages import require_group, require_member
from app.services.realtime import hub

log = logging.getLogger(__name__)

KEEP_SCORE = 0.6  # backfill keeps candidates at least this memorable
BACKFILL_KEEP = 8  # ... and at most this many per group
SUGGEST_SCORE = 0.6  # live detection suggests at least this memorable
MEDIA_BONUS = 0.1  # a moment with a photo or replay counts this much more memorable
# Same moment (Titan embeddings): the same story told twice scores ~0.6-0.75, different
# moments of one running joke ~0.5, unrelated moments < 0.4.
MERGE_SIMILARITY = 0.6
MERGE_WITH_TERM = 0.45  # ... or this close and sharing an inside term
# Talk right after a Guess that Lore round is the group remembering that lore: it
# merges into it when it starts within GAME_TALK of the round and is about as close.
CHAT_KINDS = ("text", "photo")  # what moments are told from (not system or game lines)
GAME_TALK = timedelta(minutes=30)
GAME_TALK_SIMILARITY = 0.3
MAX_KEY_MESSAGES = 8
MAX_EVIDENCE = 16  # messages kept per lore, however many moments merge into it
MAX_TERMS = 5
CONCURRENCY = 6
# live triggers on messages since the last scan
BURST_MESSAGES = 30
PHOTO_CLUSTER = 2
REACTION_PILE = 3
SCAN_CONTEXT = 10  # lines before the new ones, for context
SCAN_MAX_LINES = 150
RELATED_LIMIT = 6
FEED_MAX = 50
FEED_EVENTS = 3  # feed cards carry the hero and the next two events ...
FEED_SNIPPETS = 3  # ... with this many snippets each; the detail page has them all
MAX_MEDIA = 6
DECK_HALF_LIFE_DAYS = 14
# events
MAX_EVENTS = 6
SNIPPETS = 4  # per photo (its caption included) or quote
PER_SENDER = 2
SNIPPET_CHARS = 140
PHOTO_AFTER_IDS = 40  # a photo's lines: the next 40 messages ...
PHOTO_AFTER = timedelta(minutes=15)  # ... within 15 min, plus replies within a day
REPLY_WITHIN = timedelta(hours=24)
SIGNAL_LEAD_MS = 4_000  # a replay clip ends this long after its signal (SETTLE_S)
SPOKEN_BEFORE_MS, SPOKEN_AFTER_MS = 8_000, 4_000  # caption lines around the signal
SPOKEN_TURNS = 3
AFTER_CALL = timedelta(minutes=10)  # chat right after a replay ...
AFTER_SNIPPETS, AFTER_MIN_SCORE = 2, 2.0  # ... up to two lines scoring this
LAUGH = re.compile(r"😭|😂|🤣|💀|\b(?:lmf?ao+|lol+|haha+|dead|no way)\b", re.IGNORECASE)
FILLER = re.compile(r"^(?:ok(?:ay)?|k+|omw)\W*$|\bwhat time\b|\bwhere are\b", re.I)

# Shared with the call replay titler (app/services/replays.py).
TITLE_RULE = """48 characters or fewer. It must make sense to a member who sees \
only it and the photo or clip: who + what (+ where), like "Mike sets off the ramen \
alarm again". A headline, not a sentence: no "The Incident:"-style prefixes, no \
generic words (moment, vibes, chaos), no quotes, no emoji."""

DETECT_SYSTEM = (
    """You curate a group chat's "lore": the moments its members will want \
to look back on. Input lines look like `[#<message id> <HH:MM> <name>] text` under \
`--- <day> ---` headers; photos appear as `[photo: <description>] <caption>`.
Pick moments that matter to this group: an inside joke or nickname being born, a funny \
incident, a trip, party or game, drama, big news, a plan that became a tradition. Skip \
logistics, small talk and anything only one person cared about.
Use only what the lines say; never invent events, people or details.
Return only JSON: {"moments": [{"title": str, "story": str, "start_message_id": int, \
"end_message_id": int, "key_message_ids": [int], "hero_message_id": int | null, \
"terms": [str], "score": number}]}
- title: """
    + TITLE_RULE
    + """
- story: 1-3 plain sentences a newcomer understands: what happened and why it stuck.
- key_message_ids: up to 8 ids from the input that tell the story. They MUST include \
every photo in the moment.
- hero_message_id: the id of the photo that best shows the moment, or null when it has \
no photo.
- terms: inside terms or nicknames involved, spelled as in the chat.
- score: 0-1, how memorable this is to the group (logistics ~0.1, a legendary \
night ~0.9).
Return {"moments": []} when nothing qualifies."""
)


# ------------------------------------------------------------------- views


async def _users(session: AsyncSession, ids: Iterable[str]) -> dict[str, User]:
    ids = list(dict.fromkeys(ids))
    if not ids:
        return {}
    rows = await session.scalars(select(User).where(User.id.in_(ids)))
    return {u.id: u for u in rows}


async def _messages(session: AsyncSession, ids: Iterable[int]) -> list[Message]:
    ids = list(set(ids))
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


def _cut(text_: str) -> str:
    text_ = " ".join(text_.split())
    if len(text_) <= SNIPPET_CHARS:
        return text_
    return text_[: SNIPPET_CHARS - 1].rstrip() + "…"


class _Events:
    """Turns stored events into API events for one viewer."""

    def __init__(
        self,
        messages: dict[int, Message],
        replays: dict[int, LoreReplay],
        users: dict[str, schemas.User],
        key: set[int],
        viewer_id: str | None,
    ) -> None:
        self.messages, self.replays, self.users = messages, replays, users
        self.key, self.viewer_id = key, viewer_id

    def snippet(self, m: Message, reason: str) -> schemas.LoreSnippet:
        return schemas.LoreSnippet(
            message_id=m.id,
            user=self.users.get(m.sender_id or ""),
            text=_cut(m.text),
            ts=m.ts,
            reactions=[schemas.Reaction.model_validate(r) for r in m.reactions],
            reason=reason,  # type: ignore[arg-type]
            start_ms=None,
            is_me=bool(self.viewer_id) and m.sender_id == self.viewer_id,
        )

    def lines(self, e: dict[str, Any]) -> list[Message]:
        return [
            self.messages[i] for i in e.get("snippet_ids", []) if i in self.messages
        ]

    def reason(self, m: Message, anchor: Message) -> str:
        if m.reply_to == anchor.id:
            return "reply"
        if m.id in self.key:
            return "key"
        return "reaction" if m.reactions else "after"

    def event(self, e: dict[str, Any], limit: int | None) -> schemas.LoreEvent | None:
        kind = e.get("kind")
        snippets: list[schemas.LoreSnippet] = []
        if kind in ("photo", "quote"):
            anchor = self.messages.get(e.get("message_id") or 0)
            if anchor is None:
                return None
            if kind == "photo" and anchor.text.strip():
                snippets.append(self.snippet(anchor, "caption"))
            snippets += [self.snippet(m, self.reason(m, anchor)) for m in self.lines(e)]
            out = schemas.LoreEvent(
                kind=kind,
                at=anchor.ts,
                message=schemas.Message.model_validate(anchor),
                replay=None,
                snippets=snippets,
            )
        elif kind == "replay":
            r = self.replays.get(e.get("replay_id") or 0)
            if r is None:
                return None
            snippets += self.spoken(r, e.get("caption_idx", []))
            snippets += [self.snippet(m, "after") for m in self.lines(e)]
            out = schemas.LoreEvent(
                kind="replay",
                at=r.started_at,
                message=None,
                replay=replay_view(r),
                snippets=snippets,
            )
        else:
            return None
        if limit is not None:
            out.snippets = out.snippets[:limit]
        return out

    def spoken(self, r: LoreReplay, idx: list[int]) -> list[schemas.LoreSnippet]:
        """Caption lines merged into speaker turns (consecutive lines, one speaker)."""
        turns: list[list[dict[str, Any]]] = []
        last = None
        for i in idx:
            if not 0 <= i < len(r.captions):
                continue
            c = r.captions[i]
            if turns and last == i - 1 and turns[-1][-1]["user_id"] == c["user_id"]:
                turns[-1].append(c)
            else:
                turns.append([c])
            last = i
        return [
            schemas.LoreSnippet(
                message_id=None,
                user=self.users.get(t[0]["user_id"]),
                text=_cut(" ".join(c["text"] for c in t)),
                ts=r.started_at + timedelta(milliseconds=t[0]["start_ms"]),
                reactions=[],
                reason="spoken",
                start_ms=t[0]["start_ms"],
                is_me=bool(self.viewer_id) and t[0]["user_id"] == self.viewer_id,
            )
            for t in turns
        ]


def _hero_first(
    events: list[schemas.LoreEvent], hero_id: int | None
) -> list[schemas.LoreEvent]:
    """The hero (its photo or quote, else the first replay) leads; the rest stay
    oldest first."""
    if not events:
        return events
    i = next(
        (i for i, e in enumerate(events) if e.message and e.message.id == hero_id),
        None,
    )
    if i is None:
        i = next((i for i, e in enumerate(events) if e.kind == "replay"), 0)
    return [events[i], *events[:i], *events[i + 1 :]]


async def view(
    session: AsyncSession,
    lore: Lore,
    viewer_id: str | None = None,
    *,
    full: bool = False,
    pinned: bool | None = None,
) -> schemas.Lore:
    """The API shape. Feed-sized unless `full` (the detail page: every event and
    snippet). `pinned` skips the lookup when the caller already knows."""
    known = None if pinned is None else {lore.id: pinned}
    return (await views(session, [lore], viewer_id, full=full, pinned=known))[0]


async def views(
    session: AsyncSession,
    lores: Sequence[Lore],
    viewer_id: str | None = None,
    *,
    full: bool = False,
    pinned: dict[int, bool] | None = None,
) -> list[schemas.Lore]:
    """view() for many lore with one query per table, not per lore: a feed page
    over a remote database. `pinned` maps lore ids the caller already knows."""
    if not lores:
        return []
    groups: dict[int, tuple[str, nudge.GlossaryIndex]] = {}
    for gid in dict.fromkeys(lore.group_id for lore in lores):
        group = await require_group(session, gid)
        name = (await crud.group_view(session, group, viewer_id)).name
        groups[gid] = (name, await nudge.glossary_index(session, gid))
    replays = {
        r.id: r
        for r in await _replays(session, [i for lore in lores for i in lore.replay_ids])
    }
    stored: dict[int, tuple[list[dict[str, Any]], int | None]] = {}
    for lore in lores:
        if lore.events is None:  # not computed yet; the startup backfill stores these
            own = [replays[i] for i in lore.replay_ids if i in replays]
            stored[lore.id] = await _compute(
                session, lore.group_id, list(lore.message_ids), own, list(lore.terms)
            )
        else:
            stored[lore.id] = (lore.events, lore.hero_message_id)
    events = [e for evs, _ in stored.values() for e in evs]
    by_id = {
        m.id: m
        for m in await _messages(
            session,
            [
                *(i for lore in lores for i in lore.message_ids),
                *(e["message_id"] for e in events if e.get("message_id")),
                *(i for e in events for i in e.get("snippet_ids", [])),
            ],
        )
    }
    users = await _users(
        session,
        [
            *(p for lore in lores for p in lore.people),
            *(lore.kept_by for lore in lores if lore.kept_by),
            *(m.sender_id for m in by_id.values() if m.sender_id),
            *(c["user_id"] for r in replays.values() for c in r.captions),
        ],
    )
    people = {u: schemas.User.model_validate(users[u]) for u in users}
    pins = dict(pinned or {})
    unknown = [lore.id for lore in lores if lore.id not in pins]
    if unknown:
        found: set[int] = set()
        if viewer_id:
            found = set(
                await session.scalars(
                    select(LorePin.lore_id).where(
                        LorePin.lore_id.in_(unknown), LorePin.user_id == viewer_id
                    )
                )
            )
        pins.update({i: i in found for i in unknown})
    out = []
    for lore in lores:
        group_name, index = groups[lore.group_id]
        own = sorted(
            (replays[i] for i in lore.replay_ids if i in replays),
            key=lambda r: r.started_at,
        )
        out.append(
            _view(
                lore,
                *stored[lore.id],
                by_id=by_id,
                replays=own,
                people=people,
                group_name=group_name,
                index=index,
                viewer_id=viewer_id,
                full=full,
                pinned=pins[lore.id],
            )
        )
    return out


def _view(
    lore: Lore,
    stored: list[dict[str, Any]],
    hero_id: int | None,
    *,
    by_id: dict[int, Message],
    replays: list[LoreReplay],
    people: dict[str, schemas.User],
    group_name: str,
    index: nudge.GlossaryIndex,
    viewer_id: str | None,
    full: bool,
    pinned: bool,
) -> schemas.Lore:
    messages = [by_id[i] for i in sorted(set(lore.message_ids)) if i in by_id]
    photos = [m for m in messages if m.kind == "photo"]
    render = _Events(
        by_id, {r.id: r for r in replays}, people, set(lore.message_ids), viewer_id
    )
    built = [
        ev
        for e in stored
        if (ev := render.event(e, None if full else FEED_SNIPPETS)) is not None
    ]
    events = _hero_first(built, hero_id)
    if not full:
        events = events[:FEED_EVENTS]
    hero = events[0] if events else None
    return schemas.Lore(
        id=lore.id,
        group_id=lore.group_id,
        group_name=group_name,
        title=lore.title,
        status=lore.status,  # type: ignore[arg-type]
        source=lore.source,  # type: ignore[arg-type]
        call_id=lore.call_id,
        started_at=lore.started_at,
        ended_at=lore.ended_at,
        people=[people[p] for p in lore.people if p in people],
        terms=[
            schemas.LoreTerm(
                term=t, glossary_id=(k.id if (k := index.resolve(t)) else None)
            )
            for t in lore.terms
        ],
        hero_kind=hero.kind if hero else "quote",
        events=events,
        media=[schemas.Message.model_validate(m) for m in photos[:MAX_MEDIA]],
        cover=schemas.LoreCover(
            photo=hero.message if hero and hero.kind == "photo" else None,
            replay=hero.replay if hero else None,
        ),
        anchor_message_id=lore.anchor_message_id,
        message_count=len(messages),
        photo_count=len(photos),
        replay_count=len(replays),
        kept_by=people.get(lore.kept_by or ""),
        kept_at=lore.kept_at,
        pinned=pinned,
    )


def _personal(
    frame: schemas.Lore, user_id: str, pinned: bool, group_name: str | None = None
) -> schemas.Lore:
    """A viewer-less frame as `user_id` sees it (is_me, pinned, a DM's name)."""

    def mine(s: schemas.LoreSnippet) -> schemas.LoreSnippet:
        return s.model_copy(update={"is_me": bool(s.user and s.user.id == user_id)})

    events = [
        e.model_copy(update={"snippets": [mine(s) for s in e.snippets]})
        for e in frame.events
    ]
    update: dict[str, Any] = {"events": events, "pinned": pinned}
    if group_name is not None:
        update["group_name"] = group_name
    return frame.model_copy(update=update)


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
    base = await view(session, lore, user_id, full=True)
    return schemas.LoreDetail(
        **base.model_dump(),
        messages=[schemas.Message.model_validate(m) for m in messages],
        photos=[
            schemas.Message.model_validate(m) for m in messages if m.kind == "photo"
        ],
        replays=[
            replay_view(r) for r in await _replays(session, list(lore.replay_ids))
        ],
        related=await views(session, await related(session, lore), user_id),
    )


async def _require(
    session: AsyncSession, lore_id: int, user_id: str, lock: bool = False
) -> Lore:
    lore = await session.get(
        Lore, lore_id, with_for_update=lock or None, populate_existing=lock
    )
    if lore is None:
        raise HTTPException(404, "Lore not found")
    await require_member(session, lore.group_id, user_id)
    return lore


# -------------------------------------------------------------------- feed

EventKind = Literal["photo", "replay", "quote"]
FeedSort = Literal["deck", "recent"]


def _has(kind: str) -> Any:
    return Lore.events.contains([{"kind": kind}])


def _deck_rank() -> Any:
    """0.6·score (+MEDIA_BONUS with media) + 0.25·recency + 0.15·media."""
    media = case((_has("photo"), 1.0), (_has("replay"), 0.8), else_=0.0)
    bonus = case((or_(_has("photo"), _has("replay")), MEDIA_BONUS), else_=0.0)
    age_days = cast(func.extract("epoch", func.now() - Lore.ended_at), Float) / 86400
    recency = func.power(0.5, func.greatest(age_days, 0.0) / DECK_HALF_LIFE_DAYS)
    return 0.6 * func.least(Lore.score + bonus, 1.0) + 0.25 * recency + 0.15 * media


def _cursor(lore: Lore) -> str:
    return f"{lore.ended_at.timestamp():.6f}:{lore.id}"


async def feed(
    session: AsyncSession,
    user_id: str,
    group_id: int | None = None,
    cursor: str | None = None,
    limit: int = 20,
    *,
    kind: EventKind | None = None,
    pinned: bool = False,
    sort: FeedSort = "recent",
    q: str | None = None,
) -> schemas.LoreFeed:
    """Kept lore in the user's groups. `recent`: newest moment first. `deck`: the
    user's pins (newest pin first), then by _deck_rank. Counts ignore kind, pinned
    and the cursor, so the chips can show them."""
    if await crud.get_user(session, user_id) is None:
        raise HTTPException(404, "User not found")
    groups = select(Membership.group_id).where(Membership.user_id == user_id)
    pin = and_(LorePin.lore_id == Lore.id, LorePin.user_id == user_id)
    conds = [Lore.status == "kept", Lore.group_id.in_(groups)]
    if group_id is not None:
        conds.append(Lore.group_id == group_id)
    if q and q.strip():
        conds.append(Lore.title.icontains(q.strip(), autoescape=True))
    photo, replay, quote, pins = (
        await session.execute(
            select(
                func.count().filter(_has("photo")),
                func.count().filter(_has("replay")),
                func.count().filter(_has("quote")),
                func.count(LorePin.lore_id),
            )
            .select_from(Lore)
            .outerjoin(LorePin, pin)
            .where(*conds)
        )
    ).one()
    counts = schemas.LoreCounts(photo=photo, replay=replay, quote=quote, pinned=pins)
    stmt = select(Lore, LorePin.pinned_at).outerjoin(LorePin, pin).where(*conds)
    if kind is not None:
        stmt = stmt.where(_has(kind))
    if pinned:
        stmt = stmt.where(LorePin.lore_id.is_not(None))
    limit = max(1, min(limit, FEED_MAX))
    if sort == "deck":
        try:  # deck order moves with time, so its cursor is an offset
            offset = int(cursor.removeprefix("deck:")) if cursor else 0
        except ValueError:
            raise HTTPException(422, "Bad cursor") from None
        stmt = stmt.order_by(
            LorePin.pinned_at.desc().nulls_last(), _deck_rank().desc(), Lore.id.desc()
        ).offset(max(0, offset))
    else:
        if cursor:
            try:
                ts, lid = cursor.split(":")
                at = datetime.fromtimestamp(float(ts), UTC)
                stmt = stmt.where(
                    or_(
                        Lore.ended_at < at,
                        (Lore.ended_at == at) & (Lore.id < int(lid)),
                    )
                )
            except ValueError:
                raise HTTPException(422, "Bad cursor") from None
        stmt = stmt.order_by(Lore.ended_at.desc(), Lore.id.desc())
    rows = list((await session.execute(stmt.limit(limit + 1))).all())
    more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = None
    if more and rows:
        next_cursor = (
            f"deck:{offset + limit}" if sort == "deck" else _cursor(rows[-1][0])
        )
    return schemas.LoreFeed(
        items=await views(
            session,
            [r for r, _ in rows],
            user_id,
            pinned={r.id: at is not None for r, at in rows},
        ),
        next_cursor=next_cursor,
        counts=counts,
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
    return await views(session, list(rows), user_id)


# ------------------------------------------------------------------ events


def _terms_re(terms: Sequence[str]) -> re.Pattern[str] | None:
    keys = sorted({t.strip() for t in terms if t.strip()}, key=len, reverse=True)
    if not keys:
        return None
    return re.compile(
        r"(?<!\w)(?:" + "|".join(map(re.escape, keys)) + r")(?!\w)", re.IGNORECASE
    )


def _emoji_only(text_: str) -> bool:
    return bool(text_.strip()) and not re.search(r"\w", text_)


def _filler(text_: str) -> bool:
    t = text_.strip()
    return bool(FILLER.search(t)) or (len(t) < 3 and not _emoji_only(t))


def _score(
    m: Message,
    *,
    anchor: Message | None,
    key: set[int],
    terms: re.Pattern[str] | None,
    since: datetime,
) -> float:
    """How much a line belongs under an anchor (a photo, a quote, or the end of a
    replay when `anchor` is None)."""
    t = m.text or ""
    s = 0.0
    if anchor is not None:
        s += 3 if m.reply_to == anchor.id else 0
        s += 1 if m.sender_id != anchor.sender_id else 0
    s += 2 if m.id in key else 0
    s += min(3, len(m.reactions))
    s += 0.5 if terms and terms.search(t) else 0
    s += 1 if _emoji_only(t) or LAUGH.search(t) else 0
    s -= 2 if _filler(t) else 0
    minutes = abs((m.ts - since).total_seconds()) / 60
    return s - 0.1 * min(minutes, PHOTO_AFTER.total_seconds() / 60)


def _pick(
    scored: list[tuple[float, Message]],
    n: int,
    author: str | None = None,
    taken: Counter[str | None] | None = None,
) -> list[Message]:
    """The top `n` lines scoring above zero, at most PER_SENDER per sender
    (`taken` already counts toward it), with at least one line from someone other
    than `author` when there is one; oldest first."""
    ranked = [m for s, m in sorted(scored, key=lambda x: (-x[0], x[1].id)) if s > 0]
    per = Counter(taken or {})
    out: list[Message] = []
    for m in ranked:
        if len(out) == n:
            break
        if per[m.sender_id] < PER_SENDER:
            per[m.sender_id] += 1
            out.append(m)
    if author is not None and n and all(m.sender_id == author for m in out):
        other = next((m for m in ranked if m.sender_id != author), None)
        if other is not None:
            out = [*out[: n - 1], other]
    return sorted(out, key=lambda m: (m.ts, m.id))


def _spoken(captions: list[dict[str, Any]], signal_ms: int) -> list[int]:
    """Caption indexes around a replay's signal: whole speaker turns overlapping
    [signal - 8 s, signal + 4 s], the SPOKEN_TURNS nearest the signal."""
    lo, hi = signal_ms - SPOKEN_BEFORE_MS, signal_ms + SPOKEN_AFTER_MS
    turns: list[list[int]] = []
    for i, c in enumerate(captions):
        if c["end_ms"] < lo or c["start_ms"] > hi:
            continue
        prev = turns[-1][-1] if turns else None
        if prev == i - 1 and captions[i - 1]["user_id"] == c["user_id"]:
            turns[-1].append(i)
        else:
            turns.append([i])

    def distance(t: list[int]) -> int:
        start, end = captions[t[0]]["start_ms"], captions[t[-1]]["end_ms"]
        return max(0, start - signal_ms, signal_ms - end)

    return [i for t in sorted(sorted(turns, key=distance)[:SPOKEN_TURNS]) for i in t]


def _events(
    messages: Sequence[Message],
    key_ids: Sequence[int],
    replays: Sequence[LoreReplay] = (),
    terms: Sequence[str] = (),
    hero_hints: Sequence[int | None] = (),
) -> tuple[list[dict[str, Any]], int | None]:
    """A moment's events, oldest first, and its hero message (no LLM).

    `messages` holds the moment's key messages and the text lines around them (see
    _pool). Each key photo is an event, each replay too (at most MAX_EVENTS, the hero
    kept); a moment with neither gets one quote: its most-reacted key message. Lines
    are scored per anchor (_score), each belongs to its nearest anchor only, and the
    best few are kept (_pick). The hero is the first hint that is one of its photos,
    else its most-reacted photo, else (no message) its first replay, else the quote.
    """
    key = set(key_ids)
    terms_re = _terms_re(terms)
    photos = sorted(
        (m for m in messages if m.id in key and m.kind == "photo"), key=lambda m: m.id
    )
    photo_ids = {p.id for p in photos}
    hero = next((h for h in hero_hints if h in photo_ids), None)
    if hero is None and photos:
        hero = min(photos, key=lambda p: (-len(p.reactions), p.id)).id
    if len(photos) + len(replays) > MAX_EVENTS:
        ranked = sorted(photos, key=lambda p: (p.id != hero, -len(p.reactions), p.id))
        keep = [*ranked[:1], *replays[:1], *ranked[1:], *replays[1:]][:MAX_EVENTS]
        photos = [p for p in photos if any(p is k for k in keep)]
        replays = [r for r in replays if any(r is k for k in keep)]
    texts = sorted(
        (m for m in messages if m.kind == "text" and m.id not in photo_ids),
        key=lambda m: m.id,
    )
    out: list[tuple[datetime, dict[str, Any]]] = []
    used: set[int] = set()

    # Photos: each line goes to the photo it replies to, else the nearest one before.
    owner: dict[int, Message] = {}
    for m in texts:
        replied = next(
            (p for p in photos if m.reply_to == p.id and m.ts - p.ts <= REPLY_WITHIN),
            None,
        )
        near = next(
            (
                p
                for p in reversed(photos)
                if p.id < m.id <= p.id + PHOTO_AFTER_IDS and m.ts <= p.ts + PHOTO_AFTER
            ),
            None,
        )
        if (p := replied or near) is not None:
            owner[m.id] = p
    for p in photos:
        scored = [
            (_score(m, anchor=p, key=key, terms=terms_re, since=p.ts), m)
            for m in texts
            if owner.get(m.id) is p
        ]
        caption = bool(p.text.strip())  # the caption is the first snippet
        taken = Counter([p.sender_id] if caption else [])
        picked = _pick(scored, SNIPPETS - caption, p.sender_id, taken)
        used |= {m.id for m in picked}
        out.append(
            (
                p.ts,
                {
                    "kind": "photo",
                    "message_id": p.id,
                    "snippet_ids": [m.id for m in picked],
                },
            )
        )

    # Replays: what was said around the signal, then the chat right after the call.
    for r in replays:
        end = r.started_at + timedelta(milliseconds=r.duration_ms)
        scored = [
            (s, m)
            for m in texts
            if m.id not in used and end < m.ts <= end + AFTER_CALL
            if (s := _score(m, anchor=None, key=key, terms=terms_re, since=end))
            >= AFTER_MIN_SCORE
        ]
        picked = _pick(scored, AFTER_SNIPPETS)
        used |= {m.id for m in picked}
        out.append(
            (
                r.started_at,
                {
                    "kind": "replay",
                    "replay_id": r.id,
                    "caption_idx": _spoken(
                        r.captions, max(0, r.duration_ms - SIGNAL_LEAD_MS)
                    ),
                    "snippet_ids": [m.id for m in picked],
                },
            )
        )

    # Neither: the most-reacted key message (earliest on ties), its replies, then
    # the other key messages by score.
    keyed = [m for m in texts if m.id in key]
    if not photos and not replays and keyed:
        quote = min(keyed, key=lambda m: (-len(m.reactions), m.id))
        scored = [
            (_score(m, anchor=quote, key=key, terms=terms_re, since=quote.ts), m)
            for m in texts
            if m.id != quote.id
            and (
                m.id in key
                or (
                    m.reply_to == quote.id
                    and timedelta(0) <= m.ts - quote.ts <= REPLY_WITHIN
                )
            )
        ]
        picked = _pick(scored, SNIPPETS, quote.sender_id)
        out.append(
            (
                quote.ts,
                {
                    "kind": "quote",
                    "message_id": quote.id,
                    "snippet_ids": [m.id for m in picked],
                },
            )
        )
        hero = quote.id
    out.sort(key=lambda x: x[0])
    return [e for _, e in out], hero


async def _pool(
    session: AsyncSession,
    group_id: int,
    message_ids: list[int],
    replays: Sequence[LoreReplay],
) -> list[Message]:
    """The key messages plus every text line _events may pick around them."""
    key = await _messages(session, message_ids)
    conds = [
        Message.id.between(m.id + 1, m.id + PHOTO_AFTER_IDS)
        for m in key
        if m.kind == "photo"
    ]
    if key:
        conds.append(Message.reply_to.in_([m.id for m in key]))
    for r in replays:
        end = r.started_at + timedelta(milliseconds=r.duration_ms)
        conds.append(Message.ts.between(end, end + AFTER_CALL))
    if not conds:
        return key
    around = await session.scalars(
        select(Message).where(
            Message.group_id == group_id, Message.kind == "text", or_(*conds)
        )
    )
    return list({m.id: m for m in [*key, *around]}.values())


async def _compute(
    session: AsyncSession,
    group_id: int,
    message_ids: list[int],
    replays: Sequence[LoreReplay],
    terms: list[str],
    hero_hints: Sequence[int | None] = (),
) -> tuple[list[dict[str, Any]], int | None]:
    pool = await _pool(session, group_id, message_ids, replays)
    return _events(pool, message_ids, replays, terms, hero_hints)


async def refresh_events(
    session: AsyncSession, lore: Lore, *hero_hints: int | None
) -> None:
    """Recompute a lore row's events (after its evidence changed). Its current hero
    stays the hero while it is still one of its photos."""
    lore.events, lore.hero_message_id = await _compute(
        session,
        lore.group_id,
        list(lore.message_ids),
        await _replays(session, list(lore.replay_ids)),
        list(lore.terms),
        [lore.hero_message_id, *hero_hints],
    )


async def backfill_events(session: AsyncSession) -> int:
    """Events for lore stored before they existed (startup; SQL only)."""
    rows = list(await session.scalars(select(Lore).where(Lore.events.is_(None))))
    for row in rows:
        await refresh_events(session, row)
    if rows:
        await session.commit()
        log.info("lore: computed events for %d entries", len(rows))
    return len(rows)


# -------------------------------------------------------------------- pins


async def pin(session: AsyncSession, lore_id: int, user_id: str) -> schemas.Lore:
    lore = await _require(session, lore_id, user_id)
    if lore.status != "kept":
        raise HTTPException(409, "Only kept lore can be pinned")
    await session.execute(
        pg_insert(LorePin)
        .values(user_id=user_id, lore_id=lore.id)
        .on_conflict_do_nothing()
    )
    await session.commit()
    return await _pinned(session, lore, user_id, True)


async def unpin(session: AsyncSession, lore_id: int, user_id: str) -> schemas.Lore:
    lore = await _require(session, lore_id, user_id)
    await session.execute(
        delete(LorePin).where(LorePin.lore_id == lore.id, LorePin.user_id == user_id)
    )
    await session.commit()
    return await _pinned(session, lore, user_id, False)


async def _pinned(
    session: AsyncSession, lore: Lore, user_id: str, pinned: bool
) -> schemas.Lore:
    out = await view(session, lore, user_id, pinned=pinned)
    await hub.send([user_id], "lore.updated", out)  # pins are private
    return out


# ----------------------------------------------------------------- actions


async def announce(
    session: AsyncSession, lore: Lore, user_ids: list[str] | None = None
) -> None:
    """Push `lore.updated` to the group (or `user_ids`), as each member sees it."""
    frame = await view(session, lore)
    if user_ids is None:
        user_ids = await crud.member_ids(session, lore.group_id)
    pinners = set(
        await session.scalars(select(LorePin.user_id).where(LorePin.lore_id == lore.id))
    )
    names: dict[str, str] = {}  # a DM is named after the other member, per viewer
    group = await require_group(session, lore.group_id)
    if group.is_dm:
        memberships = await crud.list_memberships(session, group.id)
        for u in user_ids:
            names[u] = (await crud.group_view(session, group, u, memberships)).name
    await asyncio.gather(
        *(
            hub.send(
                [u], "lore.updated", _personal(frame, u, u in pinners, names.get(u))
            )
            for u in user_ids
        )
    )


async def keep(session: AsyncSession, lore_id: int, user_id: str) -> schemas.Lore:
    """Suggested → kept, first tap wins. A call replay that matches existing kept lore
    is attached to it, and that lore is returned. The row is locked, so simultaneous
    taps resolve one after the other."""
    lore = await _require(session, lore_id, user_id, lock=True)
    if lore.status == "kept":
        await session.commit()
        return await view(session, lore, user_id)
    if lore.status == "dismissed" and lore.kept_by and lore.replay_ids:
        # Someone kept it a moment ago and it was folded into existing lore.
        folded = await session.scalar(
            select(Lore).where(
                Lore.group_id == lore.group_id,
                Lore.status == "kept",
                Lore.replay_ids.contains(lore.replay_ids),
            )
        )
        await session.commit()
        if folded is not None:
            return await view(session, folded, user_id)
    if lore.status != "suggested":
        await session.commit()
        raise HTTPException(409, "This moment was already dismissed")
    target = None
    if lore.source == "call":
        found = await _similar(
            session, lore.group_id, lore.embedding, list(lore.terms), exclude=lore.id
        )
        if found is not None:
            target = await session.get(
                Lore, found.id, with_for_update=True, populate_existing=True
            )
    if target is not None:
        target.replay_ids = list(dict.fromkeys([*target.replay_ids, *lore.replay_ids]))
        target.people = list(dict.fromkeys([*target.people, *lore.people]))
        target.terms = _terms(list(target.terms), list(lore.terms))
        target.ended_at = max(target.ended_at, lore.ended_at)
        await refresh_events(session, target)
        # Folded into `target`; kept_by marks it as kept rather than passed on.
        lore.status, lore.kept_by, lore.kept_at = (
            "dismissed",
            user_id,
            datetime.now(UTC),
        )
        await session.commit()
        await announce(session, lore)
        await announce(session, target)
        return await view(session, target, user_id)
    lore.status, lore.kept_by, lore.kept_at = "kept", user_id, datetime.now(UTC)
    await refresh_events(session, lore)  # a replay picks up the chat after its call
    await session.commit()
    await announce(session, lore)
    return await view(session, lore, user_id)


async def dismiss(session: AsyncSession, lore_id: int, user_id: str) -> schemas.Lore:
    lore = await _require(session, lore_id, user_id)
    if lore.status == "suggested":
        lore.status = "dismissed"
        await session.commit()
        await announce(session, lore)
    return await view(session, lore, user_id)


async def remove(session: AsyncSession, lore_id: int, user_id: str) -> schemas.Lore:
    lore = await _require(session, lore_id, user_id)
    if lore.status != "kept":
        raise HTTPException(409, "Only kept lore can be removed")
    lore.status = "removed"
    await session.commit()
    await announce(session, lore)
    return await view(session, lore, user_id)


async def for_explanation(
    session: AsyncSession,
    group_id: int,
    term: str | None,
    pressed_id: int | None,
    source_ids: list[int],
) -> list[schemas.Lore]:
    """Kept lore an explanation belongs to, best first. Lore about the explained term
    (or a glossary alias of it) leads: the term in its title, then as its first term,
    then anywhere in its terms. Then lore holding the pressed message, then lore
    sharing a cited source; score only breaks the remaining ties."""
    forms: list[str] = []
    if term:
        known = (await nudge.glossary_index(session, group_id)).resolve(term)
        forms = [term, *((known.term, *known.aliases) if known else ())]
        forms = list({_term_key(f): f for f in forms if _term_key(f)}.values())
    sources = {i for i in source_ids if i and i != pressed_id}
    conds = []
    for f in forms:
        conds.append(
            text(f":t{len(conds)} ILIKE ANY (lore.terms)").bindparams(
                **{f"t{len(conds)}": f}
            )
        )
        conds.append(Lore.title.ilike(f"%{f}%"))
    if pressed_id:
        conds.append(Lore.message_ids.contains([pressed_id]))
    if sources:
        conds.append(Lore.message_ids.overlap(list(sources)))
    if not conds:
        return []
    rows = await session.scalars(
        select(Lore).where(
            Lore.group_id == group_id, Lore.status == "kept", or_(*conds)
        )
    )
    keys = {_term_key(f) for f in forms}
    in_title = (
        re.compile(
            r"(?<!\w)(?:"
            + "|".join(re.escape(k) for k in sorted(keys, key=len, reverse=True))
            + r")(?:'s|es|s)?(?!\w)"
        )
        if keys
        else None
    )

    def rank(r: Lore) -> tuple[int, ...]:
        terms = [_term_key(t) for t in r.terms]
        titled = bool(in_title and in_title.search(r.title.lower().replace("’", "'")))
        primary = bool(terms) and terms[0] in keys
        tagged = bool(keys & set(terms))
        pressed = bool(pressed_id) and pressed_id in r.message_ids
        shared = bool(sources & set(r.message_ids))
        tier = next(
            (
                i
                for i, hit in enumerate((titled, primary, tagged, pressed, shared))
                if hit
            ),
            5,  # a loose title substring match only
        )
        # Within a tier the later signals still count before score does.
        return (tier, not primary, not tagged, not pressed, not shared)

    ranked = sorted(rows, key=lambda r: (*rank(r), -r.score, r.id))
    return [await view(session, r) for r in ranked if rank(r)[0] < 5][:2]


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
    photos: set[int] = field(default_factory=set)
    hero_id: int | None = None  # Muse's pick, then the computed hero
    events: list[dict[str, Any]] = field(default_factory=list)

    @property
    def text(self) -> str:  # what gets embedded (the story stays in, for dedupe)
        return f"{self.title}. {self.story} {' '.join(self.terms)}".strip()

    @property
    def rank(self) -> float:
        return self.score + (MEDIA_BONUS if self.photos else 0.0)


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
        key = key or span[-MAX_KEY_MESSAGES:]
        hero = as_id(m.get("hero_message_id"))
        hero = hero if hero in ids else None
        if hero is not None:  # the photo that shows it is evidence too
            key = [hero, *key]
        key = list(dict.fromkeys(key))[:MAX_KEY_MESSAGES]
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
            Candidate(
                title,
                story,
                sorted(key),
                terms,
                score,
                min(key),
                max(key),
                hero_id=hero,
            )
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
    photos_ = list(
        await session.scalars(
            select(Message.id).where(
                Message.group_id == group_id,
                Message.kind == "photo",
                Message.id.between(c.start_id, c.end_id),
            )
        )
    )
    c.message_ids = _evidence(c.message_ids, photos_, set(photos_))
    c.people = list(dict.fromkeys(m.sender_id for m in messages if m.sender_id))
    if messages:
        c.started_at, c.ended_at = messages[0].ts, messages[-1].ts
    index = await nudge.glossary_index(session, group_id)
    found = [mt.term.term for m in messages for mt in index.find(m.text or "")]
    c.terms = _terms(found, c.terms)  # glossary spellings first
    c.photos = set(photos_)
    await _candidate_events(session, group_id, c)
    c.embedding = await embeddings.embed(c.text)
    return c


async def _candidate_events(session: AsyncSession, group_id: int, c: Candidate):
    c.events, c.hero_id = await _compute(
        session, group_id, c.message_ids, [], c.terms, [c.hero_id]
    )


def _term_key(term: str) -> str:
    key = re.sub(r"[^\w' ]", "", term.lower().replace("’", "'")).strip()
    return key.removesuffix("'s")


def _terms(*groups: list[str]) -> list[str]:
    """Merge term lists, case- and punctuation-insensitively, first spelling wins."""
    seen: dict[str, str] = {}
    for t in (t for g in groups for t in g):
        if (k := _term_key(t)) and k not in seen:
            seen[k] = t
    return list(seen.values())[:MAX_TERMS]


def _evidence(first: list[int], more: list[int], photos: set[int]) -> list[int]:
    """At most MAX_EVIDENCE message ids: photos, then the original story, then more."""
    ids = list(dict.fromkeys([*sorted(photos & {*first, *more}), *first, *more]))
    return sorted(ids[:MAX_EVIDENCE])


def same_moment(a_vec: Any, a_terms: list[str], b_vec: Any, b_terms: list[str]) -> bool:
    if a_vec is None or b_vec is None:
        return False
    sim = _cosine(list(a_vec), b_vec)
    shared = {_term_key(t) for t in a_terms} & {_term_key(t) for t in b_terms}
    return sim >= MERGE_SIMILARITY or (bool(shared) and sim >= MERGE_WITH_TERM)


def shares_messages(a: list[int], b: list[int]) -> bool:
    """Two moments told from mostly the same lines (half of the smaller one, at
    least two lines): the same story even when Muse titled it differently."""
    small = min(len(set(a)), len(set(b)))
    return small > 0 and len(set(a) & set(b)) >= max(2, math.ceil(small / 2))


def _cosine(a: list[float], b: Any) -> float:
    b = list(b)
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)


async def _game_lore(
    session: AsyncSession, group_id: int, message_ids: list[int]
) -> Lore | None:
    """The kept lore of a Guess that Lore round posted at most GAME_TALK before this
    moment began (still open, or revealed no earlier than that): what the group is
    reminiscing about."""
    first = await session.get(Message, min(message_ids))
    if first is None:
        return None
    since = first.ts - GAME_TALK
    return await session.scalar(
        select(Lore)
        .join(LoreGame, LoreGame.lore_id == Lore.id)
        .where(
            LoreGame.group_id == group_id,
            LoreGame.message_id <= max(message_ids),
            LoreGame.created_at >= since - GAME_TALK,
            or_(LoreGame.revealed_at.is_(None), LoreGame.revealed_at >= since),
            Lore.status == "kept",
        )
        .order_by(LoreGame.message_id.desc())
        .limit(1)
    )


async def _similar(
    session: AsyncSession,
    group_id: int,
    vector: Any,
    terms: list[str],
    exclude: int | None = None,
    message_ids: list[int] | None = None,
) -> Lore | None:
    """The kept lore this moment matches closely enough to merge into: one told
    from mostly the same lines, else one close enough in meaning."""
    if message_ids:
        stmt = select(Lore).where(
            Lore.group_id == group_id,
            Lore.status == "kept",
            Lore.message_ids.overlap(message_ids),
        )
        if exclude is not None:
            stmt = stmt.where(Lore.id != exclude)
        shared = [
            r
            for r in await session.scalars(stmt)
            if shares_messages(message_ids, list(r.message_ids))
        ]
        if shared:
            return max(shared, key=lambda r: len(set(r.message_ids) & {*message_ids}))
        played = await _game_lore(session, group_id, message_ids)
        if played is not None and played.id != exclude:
            if vector is None or played.embedding is None:
                return played
            if _cosine(list(vector), played.embedding) >= GAME_TALK_SIMILARITY:
                return played
    if vector is None:
        return None
    stmt = select(Lore).where(
        Lore.group_id == group_id, Lore.status == "kept", Lore.embedding.is_not(None)
    )
    if exclude is not None:
        stmt = stmt.where(Lore.id != exclude)
    near = await session.scalars(
        stmt.order_by(Lore.embedding.cosine_distance(vector)).limit(3)
    )
    return next(
        (r for r in near if same_moment(vector, terms, r.embedding, list(r.terms))),
        None,
    )


async def _merge_into(session: AsyncSession, target: Lore, c: Candidate) -> None:
    target.message_ids = _evidence(list(target.message_ids), c.message_ids, c.photos)
    target.people = list(dict.fromkeys([*target.people, *c.people]))
    target.terms = _terms(list(target.terms), c.terms)
    if c.started_at and c.started_at < target.started_at:
        target.started_at = c.started_at
    if c.ended_at and c.ended_at > target.ended_at:
        target.ended_at = c.ended_at
    await refresh_events(session, target, c.hero_id)


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
        events=c.events,
        hero_message_id=c.hero_id,
        score=c.score,
        embedding=c.embedding,
        kept_at=now if status == "kept" else None,
    )


async def backfill_group(
    session: AsyncSession,
    group_id: int,
    *,
    keep_top: int = BACKFILL_KEEP,
    before: int | None = None,
) -> list[Lore]:
    """Detect moments over the whole history (or the messages before id `before`)
    and keep the strongest automatically. Candidates matching each other (or
    existing kept lore) are merged."""
    stmt = lines_query(group_id).where(Message.kind.in_(CHAT_KINDS))
    if before is not None:
        stmt = stmt.where(Message.id < before)
    lines = await fetch_lines(session, stmt.order_by(Message.id))
    size = settings.DIGEST_CHUNK_SIZE
    chunks = [lines[i : i + size] for i in range(0, len(lines), size)]
    gate = asyncio.Semaphore(CONCURRENCY)

    async def run(chunk: list[Line]) -> list[Candidate]:
        async with gate:
            return await _detect(chunk)

    found = [c for batch in await asyncio.gather(*map(run, chunks)) for c in batch]
    photos = set(
        await session.scalars(
            select(Message.id).where(
                Message.group_id == group_id, Message.kind == "photo"
            )
        )
    )
    for c in found:  # (_fill finds the same ones) moments with photos rank higher
        c.photos = {p for p in photos if c.start_id <= p <= c.end_id}
    found = [c for c in found if c.rank >= KEEP_SCORE]
    found.sort(key=lambda c: -c.rank)
    picked: list[Candidate] = []
    for c in found:
        await _fill(session, group_id, c)
        twin = next(
            (
                p
                for p in picked
                if same_moment(c.embedding, c.terms, p.embedding, p.terms)
                or shares_messages(c.message_ids, p.message_ids)
            ),
            None,
        )
        if twin:
            twin.photos |= c.photos
            twin.message_ids = _evidence(twin.message_ids, c.message_ids, twin.photos)
            twin.people = list(dict.fromkeys([*twin.people, *c.people]))
            twin.terms = _terms(twin.terms, c.terms)
            twin.hero_id = twin.hero_id or c.hero_id
            await _candidate_events(session, group_id, twin)
            continue
        if len(picked) < keep_top:
            picked.append(c)
    kept = []
    for c in picked:
        target = await _similar(
            session, group_id, c.embedding, c.terms, message_ids=c.message_ids
        )
        if target is not None:
            await _merge_into(session, target, c)
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
        .where(Message.kind.in_(CHAT_KINDS), Message.id > after)
        .order_by(Message.id)
        .limit(SCAN_MAX_LINES),
    )
    context = await fetch_lines(
        session,
        lines_query(group_id)
        .where(Message.kind.in_(CHAT_KINDS), Message.id <= after)
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
    target = await _similar(
        session, group_id, c.embedding, c.terms, message_ids=c.message_ids
    )
    if target is not None:
        await _merge_into(session, target, c)
        await session.commit()
        await announce(session, target)
        return target
    row = _new(group_id, c, "suggested")
    session.add(row)
    await session.commit()
    await announce(session, row)
    return row


async def drain() -> None:
    """Wait for scheduled detection to finish (tests, scripts)."""
    while pending := [t for t in _tasks if not t.done()]:
        await asyncio.gather(*pending, return_exceptions=True)
    _tasks.clear()  # a finished task left behind would otherwise spin this loop


def reset() -> None:
    """Forget scan positions (tests: ids repeat across databases)."""
    _last_scanned.clear()
