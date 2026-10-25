# HackRice 26 backend

Minimal FastAPI backend structured after the
[official template](https://github.com/fastapi/full-stack-fastapi-template/tree/master/backend).
Runs without a database, secrets, or frontend build.

## Run

Install Python 3.12+ and [uv](https://docs.astral.sh/uv/), then run from the repository root:

```sh
uv sync
uv run uvicorn app.main:app --reload
```

- Health: http://localhost:8000/api/v1/health
- API docs: http://localhost:8000/docs
- OpenAPI: http://localhost:8000/api/v1/openapi.json

Optionally copy `.env.example` to `.env`. Environment variables override `.env`.
Sentry is enabled outside development only when `SENTRY_DSN` is supplied.

## Layout

```text
backend/app/
  main.py          # App setup, middleware, router registration
  models.py        # API schemas; future SQLModel table models
  crud.py          # Stub for database operations
  api/
    main.py        # Collect feature routers
    deps.py        # Stub for shared dependencies (sessions, authentication)
    routes/home.py # Health endpoint; add feature modules alongside it
  core/
    config.py      # Typed environment settings
    db.py          # Stub for database engine setup
backend/tests/     # API smoke tests
```

For a new feature, add schemas to `models.py`, a router under `backend/app/api/routes/`, and
register it in `backend/app/api/main.py`. Keep route handlers focused on HTTP behavior.
When adding persistence, wire an engine in `backend/app/core/db.py`, a session dependency in
`backend/app/api/deps.py`, operations in `crud.py`, and Alembic migrations.
The database modules are documentation stubs, not active integrations.

## Checks

```sh
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

## Docker

```sh
docker build -t hackrice26 .
docker run --rm -p 8000:8000 hackrice26
```

Pass `--env-file .env` to `docker run` if you created a configuration file.

## Frontend

Blank TypeScript [Expo](https://docs.expo.dev/) app in `frontend/`:

```sh
cd frontend
npm install
npx expo start
```

## AWS infrastructure

See [infra/README.md](infra/README.md) for the single-stack AWS deployment,
service configuration, verification command, and cleanup instructions.
The deployment provisions services and hosts the backend. Text-chat features
still need to be implemented. The [Chime call API](docs/CALLS_API.md) supports
meeting creation/joining, transcript storage, and private Bedrock explanations.
