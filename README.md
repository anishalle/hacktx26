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
`MODEL_API_KEY`, `LLM_MODEL`, `LLM_REASONING_EFFORT`). Feature 1's embeddings use Amazon Bedrock
Titan v2 through the default AWS credential chain (`aws configure`, region `AWS_REGION`, default
`us-east-1`); without credentials, hold-to-explain retrieval is full-text only. Environment variables
override `.env`.
Feature 4 (calls) uses Amazon Chime SDK meetings through the same AWS credentials and Muse
realtime speech-to-text for captions; see "Calls" below.
The shared database is Postgres + pgvector on Timescale Cloud: paste its `postgres://...?sslmode=require`
connection string into `DATABASE_URL` as-is. It listens on a non-standard port that some venue
Wi-Fi blocks; use a VPN or hotspot if connections time out. Running `app.seed` against it wipes
and reseeds the shared data for everyone.

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
    routes/          # home, users, groups, ws, explain (feature 1), nudge (feature 2), catchup (feature 3)
  services/
    messages.py      # Send / react / read / paging; fan-out + digest hook
    realtime.py      # In-process WebSocket hub
    llm.py           # Muse client: complete_json, complete_text, stream_text (+ test seam)
    digests.py       # Background chunk digests for catch-up
    explain.py       # Feature 1: retrieval + grounded answer
    asks.py          # Feature 1: private ask to the member who knows
    embeddings.py    # Feature 1: Bedrock Titan windows (+ test seam)
    nudge.py         # Feature 2
    catchup.py       # Feature 3
  seed/              # python -m app.seed + fixtures/*.json
  core/
    config.py        # Typed environment settings
    db.py            # Async engine, SessionLocal, init_db()
backend/tests/       # pytest (local TEST_DATABASE_URL server, database TEST_DB_NAME, default hacktx_test)
```

## Checks

Tests need the compose database running. They use `TEST_DATABASE_URL` (default: the compose
server), never the shared `DATABASE_URL`, create a separate database there (`TEST_DB_NAME`,
default `hacktx_test`) and never call the real LLM.

```sh
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

## Dev server

The shared dev API runs on the homelab at `https://hacktx26.anishalle.com/api/v1` (Docker,
`~/apps/hacktx26`, NGINX + Let's Encrypt in front); the app uses it by default. Redeploy the
current backend with `deploy/homelab/deploy.sh` (add `--env` only to replace the server's `.env`,
which also holds its AWS keys). Point the app at a local backend with
`EXPO_PUBLIC_API_URL=http://localhost:8000/api/v1`.

## Docker

```sh
docker build -t hacktx26 .
docker run --rm -p 8000:8000 --env-file .env hacktx26
```

Inside Docker, `localhost` in `DATABASE_URL` is the container itself; use `host.docker.internal`.

## Photos

Photo messages are stored under `MEDIA_DIR` (default `backend/media`, gitignored; a Docker volume on
the homelab) and served at `/api/v1/media/<name>`; `PUBLIC_URL` sets the origin in their URLs. Muse
describes each photo after upload, and that description is how every AI feature sees it. New
columns are added to an existing database on startup (`app/core/db.py` `UPGRADES`).

## Calls

Group calls (feature 4) run on Amazon Chime through a local Expo module
(`frontend/modules/chime-call`), so they need an iOS development build; Expo Go and
`EXPO_PUBLIC_USE_MOCKS=1` run everything else, and mock mode plays a scripted call.

```sh
cd frontend
npx expo run:ios                           # build and install the dev build (Simulator or a device)
```

The backend's AWS identity needs `chime:CreateMeeting`, `CreateAttendee`, `DeleteAttendee` and
`DeleteMeeting`. Captions use Muse realtime speech-to-text through the same `MODEL_API_KEY`: each
phone streams its own mic to `/calls/{id}/audio`. A real call needs two devices with microphones.

## Frontend

Blank TypeScript [Expo](https://docs.expo.dev/) app in `frontend/`:

```sh
cd frontend
npm install
npx expo start
```
