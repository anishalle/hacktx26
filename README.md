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

TypeScript [Expo](https://docs.expo.dev/) app in `frontend/`:

```sh
cd frontend
npm install
# Copy .env.example to .env.local and set EXPO_PUBLIC_API_URL if needed.
npx expo start
```

## Feature 5: name pronunciation

Open a member's profile from the member list. For your own demo profile, tap
**Record my name**, allow microphone access, and say your name. Recording stops
automatically after three seconds (or tap **Stop recording** earlier). Preview
the clip, then **Save pronunciation**. You can record again, discard an unsaved
take, or remove the saved clip. A failed save keeps the take available to retry;
your existing saved clip stays available until a replacement saves successfully.

Speaker buttons on profiles and the member list play the saved clip without
navigation. Only one clip plays at a time. Switch the demo identity to check
another member's view. Priya, Swayam, and Alex start without recordings.

Clips persist as small audio blobs keyed by user ID in
`data/pronunciations.sqlite3` (gitignored); set `PRONUNCIATION_DB` to change the
path. Native recordings use M4A; web recordings use the browser's supported
WebM/MP4 format. Uploads are capped at 256 KB; the recorder caps duration at
three seconds. The API checks container signatures but does not decode audio
or independently verify duration.

API under `/api/v1`:

- `GET /users` and `GET /users/{id}` return profiles with a nullable, versioned
  `pronunciation_url`.
- `GET /users/{id}/pronunciation` streams the saved audio; absent clips return 404.
- `PUT /users/{id}/pronunciation` accepts raw audio bytes with an audio Content-Type.
- `DELETE /users/{id}/pronunciation` removes the saved clip.

Writes require `X-Demo-User` matching the profile ID and
`FASTAPI_ENV=development`. This is a trusted demo identity selector, not
authentication; real account authentication is outside the design's scope.

For a phone, set `EXPO_PUBLIC_API_URL` to your computer's LAN IP including
`/api/v1`, and run the backend with `--host 0.0.0.0`. For an Android emulator,
use `http://10.0.2.2:8000/api/v1`. Web microphone recording needs localhost or
HTTPS. `FRONTEND_HOST` defaults to `http://localhost:8081`; adjust it to your
web client's origin. Restart Expo after environment changes. Native development
builds must be rebuilt to include the audio module and microphone permissions.

Frontend checks:

```sh
cd frontend
npm run lint
npm run typecheck
npx expo export --platform web
```
