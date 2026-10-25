from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncConnection,
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import settings
from app.models import TSV_EXPRESSION, Base


def make_engine(url: str = settings.DATABASE_URL) -> AsyncEngine:
    return create_async_engine(
        url, pool_pre_ping=True, connect_args={"options": "-c timezone=utc"}
    )


engine = make_engine()
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


# Columns added after the shared database was created; create_all only adds tables.
UPGRADES = [
    "ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_path text",
    "ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_width integer",
    "ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_height integer",
    "ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_description text",
    "ALTER TABLE lore ADD COLUMN IF NOT EXISTS events jsonb",
    "ALTER TABLE lore ADD COLUMN IF NOT EXISTS hero_message_id bigint",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS about text",
]


async def _upgrade(conn: AsyncConnection) -> None:
    for statement in UPGRADES:
        await conn.execute(text(statement))
    current = await conn.scalar(
        text(
            """SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d
            JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
            WHERE d.adrelid = 'messages'::regclass AND a.attname = 'tsv'"""
        )
    )
    if current and "image_description" not in current:  # search photo descriptions
        await conn.execute(text("ALTER TABLE messages DROP COLUMN tsv"))
        await conn.execute(
            text(
                "ALTER TABLE messages ADD COLUMN tsv tsvector "
                f"GENERATED ALWAYS AS ({TSV_EXPRESSION}) STORED"
            )
        )
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_messages_tsv ON messages USING gin (tsv)"
            )
        )


async def init_db(bind: AsyncEngine | None = None, *, drop: bool = False) -> None:
    """Create the vector extension and every table; `drop=True` recreates them first.
    Existing databases get UPGRADES applied in place, and lore without events gets
    them computed."""
    async with (bind or engine).begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        if drop:
            await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
        await _upgrade(conn)
    # Lore from before events existed gets them once (SQL only, no model calls).
    from app.services import lore  # the services import this module

    async with AsyncSession(bind or engine, expire_on_commit=False) as session:
        await lore.backfill_events(session)
