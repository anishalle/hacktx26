"""Feature 7: Guess that Lore, a guessing round played in the chat like a poll.

Starting one posts a `game` message: a kept moment of this group with the names
masked ("Someone's 59.7 MPG Victory Lap"), "Who was it?" and 2-4 members to pick
from. Members vote (changeable until the reveal) and unlock shared hints one at a
time. It reveals when every member has voted, when the starter taps Reveal, or when
anyone does after REVEAL_AFTER; then a system line names the answer.

Every change pushes `message.updated` to each member with the game as they see it
(`my_vote`, `can_reveal`). Before the reveal only vote counts are shown, after it
who picked whom.
"""

import asyncio
import logging
import random
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.models import Glossary, Lore, LoreGame, LoreGameVote, Membership, Message, User
from app.services import llm
from app.services.digests import fetch_lines, lines_query, render_lines
from app.services.realtime import hub

log = logging.getLogger(__name__)

GAME_TEXT = "Guess that Lore 🎲"
QUESTION = "Who was it?"
PROMPT_MAX = 60
HINTS = 3
MAX_OPTIONS = 4
RECENT_GAMES = 5  # lore used in this many latest games is picked last
REVEAL_AFTER = timedelta(hours=24)
MAX_LINES = 14  # of the moment, for Muse
# Kinship words name the answer as surely as a name does ("Dad's 59.7 MPG..."), so
# they are masked and checked like names.
RELATIONS = frozenset(
    "dad daddy papa mom mommy mum mama amma nanna nana nani thatha thathayya "
    "ammamma nanamma atha atta mamayya bava anna akka bro sis brother sister "
    "grandpa grandma granny grandad grandfather grandmother uncle aunt auntie "
    "aunty".split()
)

SYSTEM = f"""You turn a group chat's saved moment ("Lore") into a round of "Guess \
that Lore", a guessing game the group plays right in the chat: everyone sees a \
name-free version of the moment's title and guesses who it was about.

Reply with JSON only:
{{"prompt": "...", "subject": "<member id>", "hints": ["...", "...", "..."]}}

- subject: the member the moment is about (the answer), by id from the member list.
- prompt: the title rewritten so it doesn't give the answer away. At most \
{PROMPT_MAX} characters. Replace every name, nickname and relation word for a \
person (Dad, Mom, bro, Thatha...) with "Someone", "Somebody" or a neutral phrase, \
and make it a little vaguer than the title while staying recognizable to someone \
who was there. Keep its fun.
- hints: exactly {HINTS} short hints, from vague to specific, that help the group \
remember the moment. No names, nicknames or relation words, and don't repeat the \
title's distinctive words or phrases.

Use only what the moment says; never invent details."""


# ------------------------------------------------------------------- masking


def _first_name(user: User) -> str:
    return user.display_name.split()[0] if user.display_name.split() else user.id


def relation(user: User) -> str | None:
    """What the family calls them, from their `about` ("Dad. 52, engineer..")."""
    words = (user.about or "").split()
    word = words[0].strip(".,:;!") if words else ""
    return word if word.lower() in RELATIONS else None


def _called(user: User) -> str:
    """How a reveal names them: "Dad" in a family chat, else their first name."""
    return relation(user) or _first_name(user)


def _own_names(user: User) -> set[str]:
    return {*user.display_name.split(), user.username, user.id} | (
        {r} if (r := relation(user)) else set()
    )


def _name_pattern(names: set[str]) -> re.Pattern[str] | None:
    words = sorted({n.strip() for n in names if len(n.strip()) >= 2}, key=len)[::-1]
    if not words:
        return None
    alts = "|".join(re.escape(w) for w in words)
    return re.compile(rf"(?<![\w])(?:{alts})(?![\w])", re.IGNORECASE)


def mask(text: str, pattern: re.Pattern[str] | None) -> str:
    """Every name in `text` becomes "Someone" (a possessive stays one)."""
    if pattern is None:
        return text
    return " ".join(pattern.sub("Someone", text).split())


def has_name(text: str, pattern: re.Pattern[str] | None) -> bool:
    return pattern is not None and pattern.search(text) is not None


def _fit(text: str, limit: int = PROMPT_MAX) -> str:
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[: limit - 1].rsplit(" ", 1)[0].rstrip(" ,.:;-")
    return f"{cut}…"


async def _forbidden(
    session: AsyncSession, group_id: int, members: list[User]
) -> re.Pattern[str] | None:
    """Names a prompt or hint must not contain: members' names and usernames,
    kinship words (Dad, Mom, Thatha...), and the group's nickname/person glossary
    terms."""
    names: set[str] = set(RELATIONS)
    for u in members:
        names |= _own_names(u)
    rows = await session.execute(
        select(Glossary.term, Glossary.aliases).where(
            Glossary.group_id == group_id, Glossary.kind.in_(("nickname", "person"))
        )
    )
    for term, aliases in rows:
        names.add(term)
        names.update(aliases or [])
    return _name_pattern(names)


# ------------------------------------------------------------------- picking


@dataclass
class Round:
    prompt: str
    subject: str
    hints: list[str]


def _ago(ts: datetime, now: datetime) -> str:
    days = (now - ts).days
    if days < 1:
        return "today"
    if days < 2:
        return "yesterday"
    if days < 14:
        return f"{days} days ago"
    if days < 60:
        return f"about {days // 7} weeks ago"
    return f"about {days // 30} months ago"


def fallback_round(
    lore: Lore,
    subject: User,
    pattern: re.Pattern[str] | None,
    now: datetime,
) -> Round:
    """No Muse (or Muse kept naming names): mask the title, plain hints."""
    initial = _first_name(subject)[:1].upper()
    photo = any(e.get("kind") == "photo" for e in lore.events or [])
    kind = "a photo" if photo else "a few messages"
    return Round(
        prompt=_fit(mask(lore.title, pattern)),
        subject=subject.id,
        hints=[
            f"It happened {_ago(lore.started_at, now)}.",
            f"It's saved with {kind} in this chat's Lore.",
            f"Their name starts with “{initial}”.",
        ],
    )


def _muse_subject(data: dict[str, Any], members: dict[str, User]) -> str | None:
    subject = str(data.get("subject") or "").strip()
    return subject if subject in members else None


def _clean_round(
    data: dict[str, Any],
    members: dict[str, User],
    pattern: re.Pattern[str] | None,
    fallback: Round,
) -> Round | None:
    """Muse's round, or None when it named names (or picked a non-member)."""
    prompt = " ".join(str(data.get("prompt") or "").split())
    subject = _muse_subject(data, members)
    if not prompt or subject is None or has_name(prompt, pattern):
        return None
    raw = data.get("hints")
    hints = [
        " ".join(h.split())
        for h in (raw if isinstance(raw, list) else [])
        if isinstance(h, str) and h.strip()
    ]
    hints = [h for h in hints if not has_name(h, pattern)][:HINTS]
    hints += fallback.hints[len(hints) :]
    return Round(prompt=_fit(prompt), subject=subject, hints=hints[:HINTS])


def _guess_subject(lore: Lore, people: list[User], members: list[User]) -> User:
    """Without Muse: the person the title names ("Dad's..."), else the first
    person in the moment. `lore.people` is just its senders in order."""
    for u in [*people, *(m for m in members if m not in people)]:
        if has_name(lore.title, _name_pattern(_own_names(u))):
            return u
    return people[0] if people else members[0]


async def make_round(
    session: AsyncSession, lore: Lore, members: list[User], now: datetime
) -> Round:
    """Muse masks the title and writes hints; retried once, then `fallback_round`
    (keeping Muse's answer when it gave a member). Commits the read transaction
    before calling Muse."""
    by_id = {u.id: u for u in members}
    pattern = await _forbidden(session, lore.group_id, members)
    people = [by_id[p] for p in lore.people if p in by_id]
    fallback = fallback_round(lore, _guess_subject(lore, people, members), pattern, now)

    lines = await fetch_lines(
        session,
        lines_query(lore.group_id)
        .where(Message.id.in_(lore.message_ids[:MAX_LINES]))
        .order_by(Message.id),
    )
    roster = "\n".join(
        f"- {u.id}: {u.display_name}" + (f" ({u.about})" if u.about else "")
        for u in members
    )
    user = (
        f"Title: {lore.title}\nStory: {lore.story}\n"
        f"People in it: {', '.join(f'{u.display_name} ({u.id})' for u in people)}\n\n"
        f"Members:\n{roster}\n\nSome of the moment's messages:\n{render_lines(lines)}"
    )
    await session.commit()  # don't hold a pooled connection across the LLM call
    subject: str | None = None
    for attempt in range(2):
        try:
            data = await llm.complete_json(SYSTEM, user, max_tokens=2500)
        except Exception as exc:  # LLMError, timeouts, transport and API errors
            log.warning("game round from Muse failed (lore %s): %s", lore.id, exc)
            break
        if (cleaned := _clean_round(data, by_id, pattern, fallback)) is not None:
            return cleaned
        subject = subject or _muse_subject(data, by_id)
        log.info("game round named names (lore %s, attempt %d)", lore.id, attempt + 1)
    if subject is not None and subject != fallback.subject:
        return fallback_round(lore, by_id[subject], pattern, now)
    return fallback


def pick_options(game_id: int, subject: str, member_ids: list[str]) -> list[str]:
    """The subject and up to 3 other members, shuffled; the same for a game id."""
    rng = random.Random(game_id)
    others = sorted(m for m in member_ids if m != subject)
    chosen = [subject, *rng.sample(others, min(len(others), MAX_OPTIONS - 1))]
    rng.shuffle(chosen)
    return chosen


async def pick_lore(
    session: AsyncSession, group_id: int, member_ids: set[str]
) -> Lore | None:
    """A random kept moment with a member in it, one not in the last few games
    first."""
    kept = list(
        await session.scalars(
            select(Lore).where(Lore.group_id == group_id, Lore.status == "kept")
        )
    )
    kept = [lore for lore in kept if set(lore.people) & member_ids]
    if not kept:
        return None
    recent = set(
        await session.scalars(
            select(LoreGame.lore_id)
            .where(LoreGame.group_id == group_id)
            .order_by(LoreGame.id.desc())
            .limit(RECENT_GAMES)
        )
    )
    fresh = [lore for lore in kept if lore.id not in recent]
    return random.choice(fresh or kept)


# ---------------------------------------------------------------------- views


@dataclass
class _Context:
    users: dict[str, schemas.User]
    members: dict[int, list[str]]  # group id -> member ids
    titles: dict[int, str]  # lore id -> title (revealed games)
    now: datetime


async def _context(session: AsyncSession, games: list[LoreGame]) -> _Context:
    user_ids = {u for g in games for u in [*g.options, g.answer_id]}
    user_ids |= {v.user_id for g in games for v in g.votes}
    users = (
        await session.scalars(select(User).where(User.id.in_(user_ids)))
        if user_ids
        else []
    )
    members: dict[int, list[str]] = {}
    group_ids = {g.group_id for g in games}
    if group_ids:
        rows = await session.execute(
            select(Membership.group_id, Membership.user_id).where(
                Membership.group_id.in_(group_ids)
            )
        )
        for gid, uid in rows:
            members.setdefault(gid, []).append(uid)
    lore_ids = {g.lore_id for g in games if g.status == "revealed"}
    titles = (
        dict(
            (
                await session.execute(
                    select(Lore.id, Lore.title).where(Lore.id.in_(lore_ids))
                )
            ).all()
        )
        if lore_ids
        else {}
    )
    return _Context(
        users={u.id: schemas.User.model_validate(u) for u in users},
        members=members,
        titles=titles,
        now=datetime.now(UTC),
    )


def _all_voted(game: LoreGame, member_ids: list[str]) -> bool:
    voters = {v.user_id for v in game.votes}
    return bool(member_ids) and set(member_ids) <= voters


def _can_reveal(game: LoreGame, viewer: str | None, ctx: _Context) -> bool:
    if game.status != "open" or viewer not in ctx.members.get(game.group_id, []):
        return False
    return (
        viewer == game.started_by
        or _all_voted(game, ctx.members.get(game.group_id, []))
        or ctx.now - game.created_at >= REVEAL_AFTER
    )


def _view(game: LoreGame, viewer: str | None, ctx: _Context) -> schemas.LoreGame:
    revealed = game.status == "revealed"
    picks: dict[str, list[str]] = {o: [] for o in game.options}
    for v in game.votes:
        picks.setdefault(v.choice, []).append(v.user_id)
    options = [
        schemas.LoreGameOption(
            user=ctx.users[o],
            votes=len(picks[o]),
            voters=[ctx.users[u] for u in picks[o] if u in ctx.users]
            if revealed
            else [],
        )
        for o in game.options
        if o in ctx.users
    ]
    mine = next((v.choice for v in game.votes if v.user_id == viewer), None)
    return schemas.LoreGame(
        id=game.id,
        group_id=game.group_id,
        message_id=game.message_id,
        lore_id=game.lore_id,
        started_by=game.started_by,
        prompt=game.prompt,
        question=game.question,
        hints=list(game.hints if revealed else game.hints[: game.hints_shown]),
        hints_total=len(game.hints),
        options=options,
        my_vote=mine,
        total_votes=len(game.votes),
        member_count=len(ctx.members.get(game.group_id, [])),
        can_reveal=_can_reveal(game, viewer, ctx),
        status="revealed" if revealed else "open",
        answer=ctx.users.get(game.answer_id) if revealed else None,
        lore_title=ctx.titles.get(game.lore_id) if revealed else None,
        created_at=game.created_at,
        revealed_at=game.revealed_at,
    )


async def attach(
    session: AsyncSession, messages: list[schemas.Message], viewer: str | None
) -> list[schemas.Message]:
    """Fill `game` on the `game` messages (one query batch for the page)."""
    ids = [m.id for m in messages if m.kind == "game"]
    if not ids:
        return messages
    games = list(
        await session.scalars(select(LoreGame).where(LoreGame.message_id.in_(ids)))
    )
    ctx = await _context(session, games)
    by_message = {g.message_id: _view(g, viewer, ctx) for g in games}
    for m in messages:
        if m.id in by_message:
            m.game = by_message[m.id]
    return messages


async def _message_view(
    session: AsyncSession, game: LoreGame, viewer: str | None
) -> schemas.Message:
    message = await session.get(Message, game.message_id)
    assert message is not None
    await session.refresh(message, ["reactions"])
    out = schemas.Message.model_validate(message)
    out.game = _view(game, viewer, await _context(session, [game]))
    return out


async def _push(session: AsyncSession, game: LoreGame, type: str) -> None:
    """The game message to every member, as each sees it (re-read first, so a
    frame never shows an older status than the database has)."""
    await session.refresh(game)
    await session.commit()
    message = await session.get(Message, game.message_id)
    assert message is not None
    await session.refresh(message, ["reactions"])
    base = schemas.Message.model_validate(message)
    ctx = await _context(session, [game])
    await asyncio.gather(
        *(
            hub.send([u], type, base.model_copy(update={"game": _view(game, u, ctx)}))
            for u in ctx.members.get(game.group_id, [])
        )
    )


# -------------------------------------------------------------------- actions


async def require_member(session: AsyncSession, group_id: int, user_id: str) -> None:
    # Imported here: services.messages and services.lore import each other, so
    # importing messages first (as `import app.seed` would via this module) fails.
    from app.services.messages import require_member as check

    await check(session, group_id, user_id)


async def start(session: AsyncSession, group_id: int, user_id: str) -> schemas.Message:
    await require_member(session, group_id, user_id)
    memberships = await crud.list_memberships(session, group_id)
    members = [m.user for m in memberships]
    if len(members) < 2:
        raise HTTPException(409, "A game needs at least two people in the chat.")
    lore = await pick_lore(session, group_id, {u.id for u in members})
    if lore is None:
        raise HTTPException(409, "No Lore yet in this group.")
    now = datetime.now(UTC)
    plan = await make_round(session, lore, members, now)

    message = Message(
        group_id=group_id, sender_id=user_id, kind="game", text=GAME_TEXT, ts=now
    )
    session.add(message)
    await session.flush()
    game = LoreGame(
        group_id=group_id,
        lore_id=lore.id,
        message_id=message.id,
        started_by=user_id,
        prompt=plan.prompt,
        question=QUESTION,
        hints=plan.hints,
        hints_shown=0,
        options=[],
        answer_id=plan.subject,
        status="open",
        created_at=now,
    )
    session.add(game)
    await session.flush()
    game.options = pick_options(game.id, plan.subject, [u.id for u in members])
    await session.commit()
    await session.refresh(game, ["votes"])
    await _push(session, game, "message.new")
    return await _message_view(session, game, user_id)


async def _require_game(session: AsyncSession, game_id: int, user_id: str) -> LoreGame:
    """The open game, row-locked until the caller commits: simultaneous votes, hints
    and reveals run one after another, so a round reveals (and posts) once."""
    game = await session.get(
        LoreGame, game_id, with_for_update=True, populate_existing=True
    )
    if game is None:
        raise HTTPException(404, "Game not found")
    await require_member(session, game.group_id, user_id)
    if game.status != "open":
        raise HTTPException(409, "This game was already revealed.")
    return game


async def vote(
    session: AsyncSession, game_id: int, body: schemas.GameVote
) -> schemas.Message:
    game = await _require_game(session, game_id, body.user_id)
    if body.choice not in game.options:
        raise HTTPException(422, "Pick one of the game's options.")
    await session.execute(
        insert(LoreGameVote)
        .values(game_id=game.id, user_id=body.user_id, choice=body.choice)
        .on_conflict_do_update(
            index_elements=["game_id", "user_id"],
            set_={"choice": body.choice, "voted_at": func.now()},
        )
    )
    await session.refresh(game, ["votes"])  # still holding the game's lock
    if _all_voted(game, await crud.member_ids(session, game.group_id)):
        return await _reveal(session, game, body.user_id)
    await session.commit()
    await _push(session, game, "message.updated")
    return await _message_view(session, game, body.user_id)


async def hint(session: AsyncSession, game_id: int, user_id: str) -> schemas.Message:
    game = await _require_game(session, game_id, user_id)
    if game.hints_shown >= len(game.hints):
        raise HTTPException(409, "No hints left.")
    game.hints_shown += 1
    await session.commit()
    await _push(session, game, "message.updated")
    return await _message_view(session, game, user_id)


async def reveal(session: AsyncSession, game_id: int, user_id: str) -> schemas.Message:
    game = await _require_game(session, game_id, user_id)
    if not _can_reveal(game, user_id, await _context(session, [game])):
        raise HTTPException(
            403, "Only the starter can reveal until everyone votes or a day passes."
        )
    return await _reveal(session, game, user_id)


async def _reveal(
    session: AsyncSession, game: LoreGame, user_id: str
) -> schemas.Message:
    now = datetime.now(UTC)
    game.status, game.revealed_at = "revealed", now
    lore = await session.get(Lore, game.lore_id)
    answer = await session.get(User, game.answer_id)
    name = _called(answer) if answer else "someone"
    line = Message(
        group_id=game.group_id,
        sender_id=None,
        kind="system",
        text=f"🎉 It was {name}: {lore.title if lore else game.prompt}",
        ts=now,
    )
    session.add(line)
    await session.commit()
    await session.refresh(line, ["reactions"])
    await session.refresh(game, ["votes"])
    await _push(session, game, "message.updated")
    member_ids = await crud.member_ids(session, game.group_id)
    await hub.send(member_ids, "message.new", schemas.Message.model_validate(line))
    return await _message_view(session, game, user_id)
