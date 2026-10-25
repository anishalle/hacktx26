import argparse
import asyncio
import logging
from datetime import UTC, datetime
from pathlib import Path

from app.core import db
from app.seed import seed


async def main(args: argparse.Namespace) -> None:
    try:
        await seed(
            digests_enabled=not args.no_digests,
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
        "--no-anchor",
        action="store_true",
        help="end the story at load time even if weekdays then don't match",
    )
    parser.add_argument(
        "fixtures",
        nargs="*",
        type=Path,
        help="fixture files (default: fixtures/*.json)",
    )
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    asyncio.run(main(parser.parse_args()))
