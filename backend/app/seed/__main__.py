import argparse
import asyncio
import logging
from datetime import UTC, datetime
from pathlib import Path

from app.core import db
from app.core.config import settings
from app.seed import copy_all_media, seed

log = logging.getLogger("app.seed")


async def main(args: argparse.Namespace) -> None:
    if args.media_only:
        n = copy_all_media()
        log.info("copied %d seed photos into %s", n, settings.MEDIA_DIR)
        return
    try:
        await seed(
            digests_enabled=not args.no_digests,
            embeddings_enabled=not args.no_embeddings,
            lore_enabled=not args.no_lore,
            paths=args.fixtures or None,
            now=datetime.now(UTC) if args.no_anchor else None,
        )
    finally:
        await db.engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        prog="python -m app.seed", description="Drop all tables and load fixtures."
    )
    parser.add_argument(
        "--no-digests", action="store_true", help="skip digest backfill"
    )
    parser.add_argument(
        "--no-embeddings",
        action="store_true",
        help="skip embedding message windows (Bedrock)",
    )
    parser.add_argument(
        "--no-lore", action="store_true", help="skip the lore backfill (Muse)"
    )
    parser.add_argument(
        "--no-anchor",
        action="store_true",
        help="end the story at load time even if weekdays then don't match",
    )
    parser.add_argument(
        "--media-only",
        action="store_true",
        help="only copy the seed photos into MEDIA_DIR (no database changes), for "
        "another server sharing the same database",
    )
    parser.add_argument(
        "fixtures",
        nargs="*",
        type=Path,
        help="fixture files (default: fixtures/*.json)",
    )
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    asyncio.run(main(parser.parse_args()))
