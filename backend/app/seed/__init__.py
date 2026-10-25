"""Fixture loader. Format: backend/app/seed/README.md. CLI: `python -m app.seed`."""

import functools
import hashlib
import io
import json
import logging
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from PIL import Image
from sqlalchemy import insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import db
from app.core.config import settings
from app.models import (
    Glossary,
    Group,
    Lore,
    LoreGame,
    LoreGameVote,
    Membership,
    Message,
    Reaction,
    User,
)
from app.services import digests, embeddings, games, lore, photos

log = logging.getLogger(__name__)
FIXTURES_DIR = Path(__file__).parent / "fixtures"
MEDIA_SRC = Path(__file__).parent / "media"  # photos the fixtures refer to by name
MEDIA_SUFFIXES = {".jpg", ".jpeg", ".png"}
EARLY_OK = timedelta(hours=12)
FIXTURE_LORE_SCORE = 0.8
Ago = Callable[[float], datetime]  # seconds before load time -> timestamp


@functools.cache
def _prepared(name: str) -> tuple[bytes, int, int]:
    """JPEG bytes and size of seed photo `name`: the file itself when it is already
    what an upload becomes (JPEG, at most photos.MAX_SIDE, no EXIF), so the bytes and
    their hash match on every machine; otherwise normalized like an upload."""
    path = MEDIA_SRC / name
    if not path.is_file():
        raise ValueError(f"seed photo {name!r} is not in {MEDIA_SRC}")
    data = path.read_bytes()
    with Image.open(io.BytesIO(data)) as image:
        ready = (
            image.format == "JPEG"
            and image.mode == "RGB"
            and max(image.size) <= photos.MAX_SIDE
            and not image.getexif()
        )
        width, height = image.size
    return (data, width, height) if ready else photos.normalize(data)


def copy_media(name: str) -> tuple[str, int, int]:
    """Put seed photo `name` in settings.MEDIA_DIR under a name derived from its
    bytes (sha256 hex + .jpg), so every server sharing a database finds it; returns
    (file name, width, height)."""
    jpeg, width, height = _prepared(name)
    stored = hashlib.sha256(jpeg).hexdigest() + ".jpg"
    path = settings.MEDIA_DIR / stored
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_bytes(jpeg)
        tmp.replace(path)
    return stored, width, height


def copy_all_media() -> int:
    """Copy every seed photo into settings.MEDIA_DIR (`--media-only`: for another
    server sharing the database); returns how many."""
    names = sorted(
        p.name
        for p in MEDIA_SRC.iterdir()
        if p.is_file() and p.suffix.lower() in MEDIA_SUFFIXES
    )
    for name in names:
        copy_media(name)
    return len(names)


def anchored_now(anchor: dict[str, str], real: datetime) -> datetime:
    """Load time for a fixture whose story was written for `anchor` (local wall time
    + IANA tz): the anchor moved by whole weeks to its latest occurrence <= real, so
    weekdays and clock times in the text match the timestamps. Loading at most
    EARLY_OK before the next occurrence uses `real` instead (a few hours of drift
    beats a week-old chat)."""
    tz = ZoneInfo(anchor["tz"])
    wall = datetime.fromisoformat(anchor["local"])
    weeks = (real.astimezone(tz).replace(tzinfo=None) - wall) // timedelta(weeks=1)
    nxt = (wall + timedelta(weeks=weeks + 1)).replace(tzinfo=tz)
    if nxt - real <= EARLY_OK:
        return real
    return (wall + timedelta(weeks=weeks)).replace(tzinfo=tz).astimezone(UTC)


@dataclass
class LoadedGroup:
    id: int
    message_ids: dict[int, int] = field(default_factory=dict)  # fixture idx -> db id
    glossary_ids: dict[str, int] = field(default_factory=dict)  # term -> db id
    lore_ids: dict[str, int] = field(default_factory=dict)  # fixture lore title -> id
    game_ids: dict[int, int] = field(default_factory=dict)  # game message idx -> id
    lore_before: int | None = None  # the lore backfill scans messages before this id


@dataclass
class LoadedFixture:
    groups: dict[str, LoadedGroup] = field(default_factory=dict)  # fixture key -> ids
    now: datetime = field(default_factory=lambda: datetime.now(UTC))

    def group_id(self, key: str) -> int:
        return self.groups[key].id

    def msg(self, key: str, idx: int) -> int:
        return self.groups[key].message_ids[idx]

    def merge(self, other: "LoadedFixture") -> None:
        self.groups.update(other.groups)


async def load_fixture_data(
    session: AsyncSession, data: dict[str, Any], *, now: datetime | None = None
) -> LoadedFixture:
    """Insert one fixture dict and commit. Offsets are seconds before `now`, which
    defaults to the real time, aligned to the fixture's "anchor" when it has one."""
    if now is None and "anchor" in data:
        now = anchored_now(data["anchor"], datetime.now(UTC))
        stale = datetime.now(UTC) - now
        if stale > timedelta(days=1):
            log.warning(
                "fixture written for %s %s; loaded %s stale to keep weekdays right",
                data["anchor"]["local"],
                data["anchor"]["tz"],
                stale,
            )
    now = now or datetime.now(UTC)
    ago = lambda s: now - timedelta(seconds=s)  # noqa: E731
    out = LoadedFixture(now=now)

    optional = ("avatar_url", "phonetic_hint", "pronunciation_audio_url", "about")
    users = [{k: None for k in optional} | u for u in data.get("users", [])]
    if users:  # users may repeat across fixture files; first definition wins
        await session.execute(pg_insert(User).on_conflict_do_nothing(), users)

    for g in data.get("groups", []):
        members, messages = g.get("members", []), g.get("messages", [])
        created = g.get("created_offset_s") or max(
            [m["joined_offset_s"] for m in members]
            + [m["offset_s"] for m in messages]
            + [0]
        )
        group = Group(
            name=g.get("name") or "",
            avatar_url=g.get("avatar_url"),
            is_dm=g.get("is_dm", False),
            created_at=ago(created),
        )
        session.add(group)
        await session.flush()
        loaded = out.groups[g["key"]] = LoadedGroup(group.id)

        ordered = sorted(messages, key=lambda m: (-m["offset_s"], m["idx"]))
        if ordered:
            rows = [_message_row(group.id, m, ago(m["offset_s"])) for m in ordered]
            stmt = insert(Message).returning(Message.id, sort_by_parameter_order=True)
            ids = (await session.scalars(stmt, rows)).all()
            loaded.message_ids = {
                m["idx"]: i for m, i in zip(ordered, ids, strict=True)
            }
            ids_by_idx = loaded.message_ids
            replies = [
                {"id": ids_by_idx[m["idx"]], "reply_to": ids_by_idx[m["reply_to_idx"]]}
                for m in ordered
                if m.get("reply_to_idx") is not None
            ]
            if replies:
                await session.execute(update(Message), replies)
            reactions = [
                {"message_id": ids_by_idx[m["idx"]], **r}
                for m in ordered
                for r in m.get("reactions", [])
            ]
            if reactions:
                await session.execute(insert(Reaction), reactions)

        ids_by_idx = loaded.message_ids
        for m in members:
            last = m.get("last_read_idx")
            session.add(
                Membership(
                    group_id=group.id,
                    user_id=m["user_id"],
                    joined_at=ago(m["joined_offset_s"]),
                    last_read_message_id=ids_by_idx[last] if last is not None else None,
                )
            )

        ts_by_idx = {m["idx"]: ago(m["offset_s"]) for m in messages}
        for t in g.get("glossary", []):
            explained = t.get("last_explained_idx")
            entry = Glossary(
                group_id=group.id,
                term=t["term"],
                aliases=t.get("aliases", []),
                meaning=t["meaning"],
                kind=t["kind"],
                confidence=t.get("confidence", 1.0),
                source=t.get("source", "seed"),
                first_seen_ts=ts_by_idx[t["first_seen_idx"]],
                last_explained_ts=ts_by_idx[explained]
                if explained is not None
                else None,
                source_message_ids=[ids_by_idx[i] for i in t.get("source_idxs", [])],
            )
            session.add(entry)
            await session.flush()
            loaded.glossary_ids[t["term"]] = entry.id

        for item in g.get("lore", []):
            row = await _add_lore(session, group.id, item, messages, ids_by_idx, ago)
            loaded.lore_ids[item["title"]] = row.id

        member_ids = {m["user_id"] for m in members}
        for m in ordered:
            if m.get("kind") == "game":
                loaded.game_ids[m["idx"]] = await _add_game(
                    session, group.id, m, loaded, member_ids, ago
                )

        before = g.get("lore_backfill_before_idx")
        loaded.lore_before = ids_by_idx[before] if before is not None else None

    await session.commit()
    return out


def _message_row(group_id: int, m: dict[str, Any], ts: datetime) -> dict[str, Any]:
    """A messages row (every row has every key, so one bulk insert keeps order)."""
    kind = m.get("kind", "text")
    row: dict[str, Any] = {
        "group_id": group_id,
        "sender_id": m.get("sender_id"),
        "kind": kind,
        "ts": ts,
        "image_path": None,
        "image_width": None,
        "image_height": None,
        "image_description": None,
    }
    if kind == "photo":
        name, width, height = copy_media(m["image"])
        row |= {
            "text": m.get("text", ""),
            "image_path": name,
            "image_width": width,
            "image_height": height,
            "image_description": m.get("image_description"),
        }
    elif kind == "game":
        row["text"] = m.get("text", games.GAME_TEXT)
    else:
        row["text"] = m["text"]
    return row


async def _add_lore(
    session: AsyncSession,
    group_id: int,
    item: dict[str, Any],
    messages: list[dict[str, Any]],
    ids_by_idx: dict[int, int],
    ago: Ago,
) -> Lore:
    """A hand-written kept moment; its events come from the lore service like any
    kept moment's."""
    by_idx = {m["idx"]: m for m in messages}
    idxs = list(item["message_idxs"])
    hero_idx = item.get("hero_idx")
    if hero_idx is not None and hero_idx not in idxs:
        idxs.append(hero_idx)
    if not idxs:
        raise ValueError(f"lore {item['title']!r} needs message_idxs")
    offsets = [by_idx[i]["offset_s"] for i in idxs]
    senders = [by_idx[i].get("sender_id") for i in sorted(idxs, key=ids_by_idx.get)]
    ended = ago(min(offsets))
    row = Lore(
        group_id=group_id,
        title=item["title"],
        story=item.get("story") or item["title"],
        status="kept",
        source="chat",
        started_at=ago(max(offsets)),
        ended_at=ended,
        people=item.get("people") or list(dict.fromkeys(s for s in senders if s)),
        terms=item.get("terms", []),
        message_ids=sorted(ids_by_idx[i] for i in idxs),
        replay_ids=[],
        anchor_message_id=max(ids_by_idx[i] for i in idxs),
        hero_message_id=ids_by_idx[hero_idx] if hero_idx is not None else None,
        score=item.get("score", FIXTURE_LORE_SCORE),
        kept_by=item.get("kept_by"),
        kept_at=ago(item["kept_offset_s"]) if "kept_offset_s" in item else ended,
    )
    session.add(row)
    await session.flush()
    await lore.refresh_events(session, row)
    return row


async def _add_game(
    session: AsyncSession,
    group_id: int,
    m: dict[str, Any],
    loaded: LoadedGroup,
    member_ids: set[str],
    ago: Ago,
) -> int:
    """The lore_games row (and votes) behind a fixture `game` message."""
    spec = m["game"]
    where = f"game message {m['idx']}"
    if spec["lore_title"] not in loaded.lore_ids:
        raise ValueError(f"{where}: no lore titled {spec['lore_title']!r} in its group")
    options, answer = list(spec["options"]), spec["answer"]
    status = spec.get("status", "open")
    hints = list(spec.get("hints", []))
    votes = spec.get("votes", [])
    problems = [
        f"options {sorted(set(options) - member_ids)} aren't members"
        if not set(options) <= member_ids
        else "",
        "answer isn't an option" if answer not in options else "",
        f"status {status!r} isn't open|revealed"
        if status not in ("open", "revealed")
        else "",
        "hints_shown exceeds the hints"
        if spec.get("hints_shown", 0) > len(hints)
        else "",
        *(
            f"vote by {v['user_id']} for {v['choice']} isn't a member's vote for an "
            "option"
            for v in votes
            if v["user_id"] not in member_ids or v["choice"] not in options
        ),
    ]
    if problems := [p for p in problems if p]:
        raise ValueError(f"{where}: {'; '.join(problems)}")
    created = ago(m["offset_s"])
    revealed_at = None
    if status == "revealed":
        offset = spec.get("revealed_offset_s")
        revealed_at = ago(offset) if offset is not None else created
    game = LoreGame(
        group_id=group_id,
        lore_id=loaded.lore_ids[spec["lore_title"]],
        message_id=loaded.message_ids[m["idx"]],
        started_by=spec.get("started_by", m.get("sender_id")),
        prompt=spec["prompt"],
        question=spec.get("question", games.QUESTION),
        hints=hints,
        hints_shown=spec.get("hints_shown", 0),
        options=options,
        answer_id=answer,
        status=status,
        created_at=created,
        revealed_at=revealed_at,
    )
    session.add(game)
    await session.flush()
    for v in votes:
        session.add(
            LoreGameVote(
                game_id=game.id,
                user_id=v["user_id"],
                choice=v["choice"],
                voted_at=ago(v.get("offset_s", m["offset_s"])),
            )
        )
    await session.flush()
    return game.id


async def embed_lore(session: AsyncSession, group_id: int) -> int:
    """Embeddings for the group's lore without one (fixture lore), so the lore
    backfill merges Muse's matching moments into it instead of repeating them."""
    rows = list(
        await session.scalars(
            select(Lore).where(Lore.group_id == group_id, Lore.embedding.is_(None))
        )
    )
    done = 0
    for row in rows:
        vector = await embeddings.embed(
            f"{row.title}. {row.story} {' '.join(row.terms)}".strip()
        )
        if vector is not None:
            row.embedding = vector
            done += 1
    await session.commit()
    return done


def fixture_paths() -> list[Path]:
    return sorted(FIXTURES_DIR.glob("*.json"))


async def seed(
    *,
    digests_enabled: bool = True,
    embeddings_enabled: bool = True,
    lore_enabled: bool = True,
    paths: list[Path] | None = None,
    now: datetime | None = None,
) -> None:
    """Drop and recreate every table, load fixtures, then embed message windows,
    backfill digests and keep each group's strongest lore. `now` overrides the load
    time (default: real time, aligned to each fixture's anchor)."""
    await db.init_db(drop=True)
    loaded = LoadedFixture()
    async with db.SessionLocal() as session:
        for path in paths or fixture_paths():
            data = json.loads(path.read_text())
            result = await load_fixture_data(session, data, now=now)
            loaded.merge(result)
            log.info("loaded %s (%d groups)", path.name, len(result.groups))
        if embeddings_enabled:
            for key, group in loaded.groups.items():
                n = await embeddings.index_group(session, group.id)
                n_lore = await embed_lore(session, group.id)
                log.info("embedded %s: %d windows, %d lore", key, n, n_lore)
        for key, group in loaded.groups.items() if digests_enabled else ():
            n = await digests.backfill_digests(session, group.id)
            log.info("digested %s: %d chunks", key, n)
        for key, group in loaded.groups.items() if lore_enabled else ():
            kept = await lore.backfill_group(
                session, group.id, before=group.lore_before
            )
            log.info("lore %s: kept %d", key, len(kept))
