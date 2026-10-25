from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.models import Base


def make_engine(url: str = settings.DATABASE_URL) -> AsyncEngine:
    return create_async_engine(
        url, pool_pre_ping=True, connect_args={"options": "-c timezone=utc"}
    )


engine = make_engine()
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def init_db(bind: AsyncEngine | None = None, *, drop: bool = False) -> None:
    """Create the vector extension and every table; `drop=True` recreates them first."""
    async with (bind or engine).begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        if drop:
            await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
