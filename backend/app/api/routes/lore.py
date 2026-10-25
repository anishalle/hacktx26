"""Feature 6: Lore.

Paths: `/users/{user_id}/lore`, `/lore/{lore_id}` (+ `/keep`, `/dismiss`, `/remove`,
`/pin`), `/groups/{group_id}/lore` ("Save to Lore") and
`/groups/{group_id}/lore/suggestions`.

Logic lives in app/services/lore.py (chat detection, backfill) and
app/services/replays.py (call replays); "Save to Lore" is below, built from the same
pieces. Routes carry full paths (no router prefix) because the feed sits under /users
and suggestions under /groups.
"""

import logging
from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import schemas
from app.api.deps import SessionDep
from app.models import Group, Lore, Message
from app.services import llm, lore
from app.services.digests import Line, as_id, fetch_lines, lines_query, render_lines
from app.services.messages import require_member, require_message

log = logging.getLogger(__name__)

router = APIRouter(tags=["lore"])


@router.get("/users/{user_id}/lore", response_model=schemas.LoreFeed)
async def lore_feed(
    user_id: str,
    session: SessionDep,
    group_id: int | None = None,
    kind: lore.EventKind | None = None,
    pinned: bool = False,
    sort: lore.FeedSort = "recent",
    q: str | None = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=lore.FEED_MAX)] = 20,
) -> schemas.LoreFeed:
    return await lore.feed(
        session,
        user_id,
        group_id,
        cursor,
        limit,
        kind=kind,
        pinned=pinned,
        sort=sort,
        q=q,
    )


@router.get("/lore/{lore_id}", response_model=schemas.LoreDetail)
async def lore_detail(
    lore_id: int, user_id: str, session: SessionDep
) -> schemas.LoreDetail:
    return await lore.detail(session, lore_id, user_id)


@router.get("/groups/{group_id}/lore/suggestions", response_model=list[schemas.Lore])
async def lore_suggestions(
    group_id: int, user_id: str, session: SessionDep
) -> list[schemas.Lore]:
    return await lore.suggestions(session, group_id, user_id)


@router.post("/lore/{lore_id}/keep", response_model=schemas.Lore)
async def keep_lore(
    lore_id: int, body: schemas.LoreAction, session: SessionDep
) -> schemas.Lore:
    return await lore.keep(session, lore_id, body.user_id)


@router.post("/lore/{lore_id}/dismiss", response_model=schemas.Lore)
async def dismiss_lore(
    lore_id: int, body: schemas.LoreAction, session: SessionDep
) -> schemas.Lore:
    return await lore.dismiss(session, lore_id, body.user_id)


@router.post("/lore/{lore_id}/remove", response_model=schemas.Lore)
async def remove_lore(
    lore_id: int, body: schemas.LoreAction, session: SessionDep
) -> schemas.Lore:
    return await lore.remove(session, lore_id, body.user_id)


@router.post("/lore/{lore_id}/pin", response_model=schemas.Lore)
async def pin_lore(
    lore_id: int, body: schemas.LoreAction, session: SessionDep
) -> schemas.Lore:
    return await lore.pin(session, lore_id, body.user_id)


@router.delete("/lore/{lore_id}/pin", response_model=schemas.Lore)
async def unpin_lore(lore_id: int, user_id: str, session: SessionDep) -> schemas.Lore:
    return await lore.unpin(session, lore_id, user_id)


# ------------------------------------------------------------- save to lore

SAVE_WINDOW = timedelta(minutes=15)  # Muse reads the chat this far either side ...
SAVE_LINES = 80  # ... at most this many lines, centered on the saved message
SAVE_SCORE = 0.7  # a member picked it: as memorable as a strong detected moment

TITLE_SYSTEM = (
    """A member of a group chat saved a message to the group's "lore", the \
moments it will want to look back on. Input lines look like `[#<message id> <HH:MM> \
<name>] text` under `--- <day> ---` headers; photos appear as `[photo: <description>] \
<caption>`. The first line names the saved message. Title the moment it belongs to.
Use only what the lines say; never invent events, people or details.
Return only JSON: {"title": str, "story": str, "key_message_ids": [int], \
"terms": [str]}
- title: """
    + lore.TITLE_RULE
    + """
- story: 1-2 plain sentences: what happened (never shown).
- key_message_ids: up to 8 ids from the input that tell this moment. They MUST \
include the saved message and every photo in the moment.
- terms: inside terms or nicknames involved, spelled as in the chat."""
)


class LoreSave(schemas.Schema):
    user_id: str
    message_id: int


@router.post("/groups/{group_id}/lore", response_model=schemas.Lore)
async def save_lore(group_id: int, body: LoreSave, session: SessionDep) -> schemas.Lore:
    return await save(session, group_id, body.user_id, body.message_id)


async def _holding(
    session: AsyncSession, group_id: int, message_id: int
) -> Lore | None:
    """Kept (else suggested) lore that already holds this message."""
    return await session.scalar(
        select(Lore)
        .where(
            Lore.group_id == group_id,
            Lore.status.in_(("kept", "suggested")),
            Lore.message_ids.contains([message_id]),
        )
        .order_by(Lore.status == "suggested", Lore.id)
        .limit(1)
    )


async def _already(session: AsyncSession, found: Lore, user_id: str) -> schemas.Lore:
    await session.commit()
    if found.status == "suggested":  # detection got there first: this keeps it
        return await lore.keep(session, found.id, user_id)
    return await lore.view(session, found, user_id)


def _keeping(ids: list[int], saved_id: int) -> list[int] | None:
    """Evidence capped at MAX_EVIDENCE drops ids, and the saved message must stay (a
    member chose it, and a lore holding it is what makes a re-save idempotent): the
    ids nearest it, it included, or None when it is already there."""
    if saved_id in ids:
        return None
    near = sorted(ids, key=lambda i: abs(i - saved_id))[: lore.MAX_EVIDENCE - 1]
    return sorted([saved_id, *near])


def _fallback_title(saved: Message, name: str) -> str:
    """When Muse can't title it: the saved line itself (it's what someone sent)."""
    words = " ".join(saved.text.split())
    if not words:
        return f"{name}'s photo" if saved.kind == "photo" else f"{name}'s message"
    return words if len(words) <= 48 else words[:47].rstrip() + "…"


async def _titled(lines: list[Line], saved: Message) -> lore.Candidate:
    """A one-moment candidate around `saved`: Muse's title, story, key lines and
    terms, or just the saved message when Muse fails."""
    ids = {line.id for line in lines}
    name = next((line.name for line in lines if line.id == saved.id), "Someone")
    try:
        data = await llm.complete_json(
            TITLE_SYSTEM,
            f"Saved message: #{saved.id}\n\n{render_lines(lines)}",
            max_tokens=1000,
        )
    except Exception as exc:
        log.warning("lore save: titling failed: %r", exc)
        data = {}
    title = " ".join(str(data.get("title") or "").split()).strip("\"'")[:80]
    story = " ".join(str(data.get("story") or "").split())[:600]
    key = [i for v in (data.get("key_message_ids") or []) if (i := as_id(v)) in ids]
    key = sorted(dict.fromkeys([saved.id, *key][: lore.MAX_KEY_MESSAGES]))
    terms = [
        " ".join(t.split())
        for t in (data.get("terms") or [])
        if isinstance(t, str) and t.strip()
    ][:6]
    if not title:
        title, story, key, terms = _fallback_title(saved, name), "", [saved.id], []
    return lore.Candidate(
        title,
        story or title,
        key,
        terms,
        SAVE_SCORE,
        min(key),
        max(key),
        hero_id=saved.id if saved.kind == "photo" else None,
    )


async def save(
    session: AsyncSession, group_id: int, user_id: str, message_id: int
) -> schemas.Lore:
    """Save to Lore, from a message's menu: the moment around it (±SAVE_WINDOW),
    titled by Muse and kept at once by `user_id`. A moment matching existing kept lore
    is merged into it; saving a message that already is lore returns (or keeps) it."""
    await require_member(session, group_id, user_id)
    saved = await require_message(session, group_id, message_id)
    if saved.kind not in ("text", "photo"):
        raise HTTPException(400, "Only messages and photos can be saved to Lore")
    found = await _holding(session, group_id, saved.id)
    if found is not None:
        return await _already(session, found, user_id)
    window = await fetch_lines(
        session,
        lines_query(group_id)
        .where(
            Message.kind != "system",
            Message.ts.between(saved.ts - SAVE_WINDOW, saved.ts + SAVE_WINDOW),
        )
        .order_by(Message.id),
    )
    at = next((i for i, line in enumerate(window) if line.id == saved.id), 0)
    start = max(0, min(at - SAVE_LINES // 2, len(window) - SAVE_LINES))
    lines = window[start : start + SAVE_LINES]
    await session.commit()  # don't hold a pooled connection across the LLM call
    c = await lore._fill(session, group_id, await _titled(lines, saved))
    if (ids := _keeping(c.message_ids, saved.id)) is not None:  # a photo dump
        c.message_ids = ids
        await lore._candidate_events(session, group_id, c)

    # One save per group at a time, so two taps on one moment make one lore.
    await session.execute(
        select(Group.id).where(Group.id == group_id).with_for_update()
    )
    found = await _holding(session, group_id, saved.id)
    if found is not None:
        return await _already(session, found, user_id)
    target = await lore._similar(session, group_id, c.embedding, c.terms)
    if target is not None:
        target = await session.get(
            Lore, target.id, with_for_update=True, populate_existing=True
        )
    if target is not None:
        await lore._merge_into(session, target, c)
        if (ids := _keeping(list(target.message_ids), saved.id)) is not None:
            target.message_ids = ids  # it was full: the saved line displaces another
            await lore.refresh_events(session, target, c.hero_id)
        await session.commit()
        await lore.announce(session, target)
        return await lore.view(session, target, user_id)
    row = lore._new(group_id, c, "kept")
    row.kept_by = user_id
    session.add(row)
    await session.commit()
    await lore.announce(session, row)
    return await lore.view(session, row, user_id)
