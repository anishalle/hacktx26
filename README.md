# HackTX 26 backend

FastAPI + Postgres/pgvector backend for the newcomer group-chat assistant. The API contract is
[`docs/API.md`](docs/API.md); product context is in [`DESIGN.md`](DESIGN.md).

## Run

Install Python 3.12+, [uv](https://docs.astral.sh/uv/) and Docker, copy `.env.example` to `.env`
(fill in `MODEL_API_KEY`), then from the repository root:

```sh
docker compose up -d                       # Postgres 17 + pgvector on localhost:5433
uv sync
uv run python -m app.seed                  # drop + recreate tables, load demo fixtures
uv run uvicorn app.main:app --reload       # tables are also created on startup
```

- API: http://localhost:8000/api/v1 (health: `/api/v1/health`, WebSocket: `/api/v1/ws?user_id=`)
- API docs: http://localhost:8000/docs

Seed options and the fixture format: [`backend/app/seed/README.md`](backend/app/seed/README.md).
The LLM is Meta's Muse through the OpenAI-compatible Meta Model API (`MODEL_API_BASE_URL`,
`MODEL_API_KEY`, `LLM_MODEL`, `LLM_REASONING_EFFORT`). Environment variables override `.env`.
Production points `DATABASE_URL` at AWS RDS.

## Layout

```text
backend/app/
  main.py            # App setup, lifespan (init_db), router registration
  models.py          # SQLAlchemy tables (docs/API.md "Data model")
  schemas.py         # Pydantic API shapes (docs/API.md "Shapes")
  crud.py            # Shared queries (unread counts, group views, memberships)
  api/
    main.py          # Collect feature routers
    deps.py          # SessionDep
    routes/          # home, users, groups, ws, nudge (feature 2), catchup (feature 3)
  services/
    messages.py      # Send / react / read / paging; fan-out + digest hook
    realtime.py      # In-process WebSocket hub
    llm.py           # Muse client: complete_json, complete_text, stream_text (+ test seam)
    digests.py       # Background chunk digests for catch-up
    nudge.py         # Feature 2
    catchup.py       # Feature 3
  seed/              # python -m app.seed + fixtures/*.json
  core/
    config.py        # Typed environment settings
    db.py            # Async engine, SessionLocal, init_db()
backend/tests/       # pytest (uses a separate database, TEST_DB_NAME, default hacktx_test)
```

## Checks

Tests need the compose database running; they create and use a separate database
(`TEST_DB_NAME`, default `hacktx_test`) on the same server and never call the real LLM.

```sh
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

## Docker

```sh
docker build -t hacktx26 .
docker run --rm -p 8000:8000 --env-file .env hacktx26
```

Inside Docker, `localhost` in `DATABASE_URL` is the container itself; use `host.docker.internal`.

## Frontend

Blank TypeScript [Expo](https://docs.expo.dev/) app in `frontend/`:

```sh
cd frontend
npm install
npx expo start
```
