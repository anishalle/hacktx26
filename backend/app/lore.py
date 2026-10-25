"""Lore backfill on an existing database (feature 6).

    uv run python -m app.lore backfill              # every group
    uv run python -m app.lore backfill --group 1    # one group id
    uv run python -m app.lore backfill --replace    # drop backfilled lore first

Runs Muse over each group's history and keeps the strongest moments; lore that
matches existing kept lore is merged into it rather than duplicated.
"""

import argparse
import asyncio
import logging

from sqlalchemy import delete, select

from app.core import db
from app.models import Group, Lore
from app.services import lore


async def backfill(group_id: int | None, replace: bool) -> None:
    await db.init_db()
    try:
        async with db.SessionLocal() as session:
            stmt = select(Group).order_by(Group.id)
            if group_id is not None:
                stmt = stmt.where(Group.id == group_id)
            for group in await session.scalars(stmt):
                if replace:  # backfilled = kept by nobody
                    await session.execute(
                        delete(Lore).where(
                            Lore.group_id == group.id,
                            Lore.source == "chat",
                            Lore.kept_by.is_(None),
                        )
                    )
                    await session.commit()
                kept = await lore.backfill_group(session, group.id)
                logging.info("%s: kept %d", group.name, len(kept))
                for row in kept:
                    logging.info("  - %s", row.title)
    finally:
        await db.engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(prog="python -m app.lore")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("backfill", help="keep each group's strongest moments")
    run.add_argument("--group", type=int, help="only this group id")
    run.add_argument(
        "--replace", action="store_true", help="drop backfilled lore first"
    )
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    args = parser.parse_args()
    asyncio.run(backfill(args.group, args.replace))
