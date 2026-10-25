"""Fixture loader. Format: backend/app/seed/README.md. CLI: `python -m app.seed`."""

import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import insert, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import db
from app.models import Glossary, Group, Membership, Message, Reaction, User
from app.services import digests, embeddings, lore

log = logging.getLogger(__name__)
FIXTURES_DIR = Path(__file__).parent / "fixtures"
EARLY_OK = timedelta(hours=12)


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

    optional = ("avatar_url", "phonetic_hint", "pronunciation_audio_url")
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
            rows = [
                {
                    "group_id": group.id,
                    "sender_id": m.get("sender_id"),
                    "kind": m.get("kind", "text"),
                    "text": m["text"],
                    "ts": ago(m["offset_s"]),
                }
                for m in ordered
            ]
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

    await session.commit()
    return out


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
                log.info("embedded %s: %d windows", key, n)
        for key, group in loaded.groups.items() if digests_enabled else ():
            n = await digests.backfill_digests(session, group.id)
            log.info("digested %s: %d chunks", key, n)
        for key, group in loaded.groups.items() if lore_enabled else ():
            kept = await lore.backfill_group(session, group.id)
            log.info("lore %s: kept %d", key, len(kept))
