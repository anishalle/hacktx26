"""Shared test fixtures.

- Tests use a separate database (env TEST_DB_NAME, default "hacktx_test") on the
  DATABASE_URL server: tables are created once, truncated before each test.
- `app.core.db.engine` / `SessionLocal` are rebound to it, so routes, WS and
  background code that use them hit the test database.
- Every test has a FakeLLM installed (an unexpected LLM call fails the test);
  request `fake_llm` to script it. See app/services/llm.py.
"""

import json
import os
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from httpx_ws import AsyncWebSocketSession, aconnect_ws
from httpx_ws.transport import ASGIWebSocketTransport
from sqlalchemy import make_url, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core import db
from app.core.config import settings
from app.main import app
from app.models import Base
from app.seed import FIXTURES_DIR, LoadedFixture, load_fixture_data
from app.services import llm
from app.services.realtime import hub

LoadFixture = Callable[..., Awaitable[LoadedFixture]]
WsConnect = Callable[[str], AbstractAsyncContextManager[AsyncWebSocketSession]]


async def _ensure_database(name: str) -> str:
    url = make_url(settings.DATABASE_URL)
    admin = create_async_engine(url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as conn:
        found = await conn.scalar(
            text("SELECT 1 FROM pg_database WHERE datname = :n"), {"n": name}
        )
        if not found:
            await conn.execute(text(f'CREATE DATABASE "{name}"'))
    await admin.dispose()
    return url.set(database=name).render_as_string(hide_password=False)


@pytest.fixture(scope="session", autouse=True)
async def test_db() -> AsyncIterator[None]:
    url = await _ensure_database(os.environ.get("TEST_DB_NAME", "hacktx_test"))
    engine = db.make_engine(url)
    await db.init_db(engine, drop=True)
    saved = db.engine, db.SessionLocal
    db.engine, db.SessionLocal = (
        engine,
        async_sessionmaker(engine, expire_on_commit=False),
    )
    yield
    db.engine, db.SessionLocal = saved
    await engine.dispose()


@pytest.fixture(autouse=True)
async def _clean(test_db: None) -> AsyncIterator[None]:
    tables = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
    async with db.engine.begin() as conn:
        await conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
    hub.clear()
    yield
    hub.clear()


@pytest.fixture(autouse=True)
def fake_llm() -> Iterator[llm.FakeLLM]:
    fake = llm.FakeLLM()
    llm.set_llm_backend(fake)
    yield fake
    llm.set_llm_backend(None)


@pytest.fixture
async def session() -> AsyncIterator[AsyncSession]:
    async with db.SessionLocal() as s:
        yield s


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


@asynccontextmanager
async def _ws_connect(user_id: str) -> AsyncIterator[AsyncWebSocketSession]:
    transport = ASGIWebSocketTransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        async with aconnect_ws(f"/api/v1/ws?user_id={user_id}", c) as ws:
            yield ws


@pytest.fixture
def ws_connect() -> WsConnect:
    """`async with ws_connect("priya") as ws:` inside the test body (not a fixture:
    the ASGI WS transport must enter and exit in the same task)."""
    return _ws_connect


@pytest.fixture
def load_fixture() -> LoadFixture:
    """`fx = await load_fixture(data, now=None)`; data uses the seed fixture format."""

    async def load(data: dict[str, Any], now: datetime | None = None) -> LoadedFixture:
        async with db.SessionLocal() as s:
            return await load_fixture_data(s, data, now=now)

    return load


TEST_FIXTURES_DIR = Path(__file__).parent / "fixtures"


def read_fixture(name: str) -> dict[str, Any]:
    """backend/tests/fixtures/<name>, else backend/app/seed/fixtures/<name>."""
    path = TEST_FIXTURES_DIR / name
    return json.loads((path if path.exists() else FIXTURES_DIR / name).read_text())


@pytest.fixture
async def sample(load_fixture: LoadFixture) -> LoadedFixture:
    """backend/tests/fixtures/sample.json, loaded."""
    return await load_fixture(read_fixture("sample.json"))
