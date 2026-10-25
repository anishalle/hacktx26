# Newcomer group chat assistant

Expo / React Native chat with a FastAPI backend. Hold a message or tap **?** for a
private explanation grounded in the group's own history. Claude and Titan
Embeddings both run through Amazon Bedrock; RDS PostgreSQL with pgvector stores
and searches the embeddings.

## Use the existing AWS stack

Use the existing **hacktx-newcomer** CloudFormation stack in **us-east-1**, account
**407902218075**. No provisioning or deployment is performed by the setup helper.

1. Install AWS CLI v2.32+ and sign in with your assigned IAM user:

   ```sh
   aws login --profile hacktx --region us-east-1
   aws sts get-caller-identity --profile hacktx --region us-east-1
   ```

   Complete browser sign-in and the first-sign-in password change if prompted.
   Check that the account is **407902218075**. The backend includes Boto3's CRT
   dependency to read and refresh this login session; no access keys are needed.
   Run `aws login` again when the session expires. Keep credentials out of the
   repository and preserve any existing default profile.
2. Install Python 3.12+ and uv, then run from the repository root:

   ```sh
   uv sync
   uv run python scripts/discover_aws.py --profile hacktx --write-env
   ```

   This verifies the account, reads stack resources/outputs, and writes
   **.env.aws.local** (gitignored). It does not fetch or print secret values.
   It detects one PostgreSQL cluster, its Data API setting, Secrets Manager ARN,
   and Titan model output when unambiguous. It selects an active Claude Haiku 4.5
   inference profile. If multiple database candidates exist, select one manually.
   It never changes security groups or networking.
3. Copy `.env.example` to `.env`, remove unused empty settings, and set
   `BEDROCK_CLAUDE_MODEL_ID` to the enabled Claude model or inference profile ID
   in this account. The helper discovers it if the stack exports a clearly named
   Claude model/profile output. Environment variables override both files;
   `.env` overrides `.env.aws.local`.
4. This stack enables Aurora Data API, so the app uses `DATABASE_CLUSTER_ARN`,
   `DATABASE_SECRET_ARN`, and `DATABASE_NAME`; this works with the private
   cluster and avoids opening database network access. Otherwise use the detected
   `DATABASE_HOST` and connect through an existing VPC tunnel. Migrations create
   only the missing chat tables and indexes; the existing pgvector extension is
   reused.

The app needs `bedrock:InvokeModel` for Titan and the chosen Claude model/profile,
`secretsmanager:GetSecretValue` for the database secret (plus `kms:Decrypt` if
applicable), and database/network access. Discovery additionally needs read access
to STS, CloudFormation, and RDS.

## Initialize and run

After configuring the existing database:

```sh
uv run python -m app.commands migrate
uv run python -m app.commands seed
uv run python -m app.commands index
uv run uvicorn app.main:app --host 0.0.0.0 --reload
```

The idempotent migration and seed create **Priya**, **Swayam**, and **Alex** in the **longhorns**
group, with 440 synthetic messages. Priya joins at the end of the history.
Indexing generates 1,024-dimensional Titan embeddings, commits each separately,
and resumes after interruption. No fake embeddings are used by the app.

In a separate terminal, keep new messages indexed:

```sh
uv run python -m app.commands index --watch
```

New messages are immediately available to PostgreSQL full-text search; the worker
adds semantic search embeddings. Bedrock failures do not prevent sending messages.

Start the client:

```sh
cd frontend
npm ci
# Copy .env.example to .env.local and set your API URL.
npm start
```

For a physical phone, set `EXPO_PUBLIC_API_URL` to your computer's LAN address or
existing HTTPS tunnel, including `/api/v1`. Android emulators can use
`http://10.0.2.2:8000/api/v1`. Restart Expo after changing environment variables.
For web, set `FRONTEND_HOST` to its origin (default `http://localhost:8081`).

- Health: http://localhost:8000/api/v1/health (works without AWS/database settings)
- API docs: http://localhost:8000/docs
- OpenAPI: http://localhost:8000/api/v1/openapi.json

## Demo

1. Stay as **Priya**, hold **Grandma's after the game.** or tap its **?**.
   The sheet should explain Swayam's house and cite the older messages.
2. Tap a source to jump to the original conversation, then **Back to latest**.
3. Ask a follow-up; it uses the original retrieved history.
4. Explain **Bring the moon waffle.**, which is deliberately undefined.
   Tap **Ask Swayam** to send a private request.
5. Switch the demo identity to **Swayam**, open **Private explanations**, and send
   a short answer or pass. Switch back to **Priya** to see the reply. **Alex**
   cannot see that request or answer. Nothing is posted to the group.
6. Explain **ok see you at 7** to check the plain-language result.

The identity selector and `X-Demo-User` header are intentionally for a trusted
hackathon demo, not authentication. Do not expose this API publicly as a private
messaging service without adding authentication. `DEMO_MODE=false` disables
these endpoints until real authentication is supplied. Requests/replies and chat
updates are polled every four seconds; no push service is needed.

## Retrieval and privacy

Messages are embedded individually as search anchors. Retrieval combines
PostgreSQL full-text ranking with pgvector cosine search using reciprocal rank
fusion, scoped to one group. Each retained hit expands to **100 consecutive
messages before it and 100 after it**, plus the hit itself. The selected message
also gets that surrounding context. Ordering is stable by timestamp and ID,
including timestamp ties. Overlapping windows are deduplicated.

The default is three search hits. If context exceeds `CONTEXT_MAX_CHARS`, fewer
complete hit windows are retained; a window is never silently shortened. If the
selected message's own window cannot fit, the API reports that explicitly.
These larger windows supersede the design's original 10-message windows and
4,000-token target; latency depends on the model and context size.

Claude returns a short meaning and up to three evidence messages. Unknown or
low-confidence answers, missing evidence, and invalid citation IDs produce an
honest fallback. Follow-ups reference a server-stored context ID bound to the
user, group, and selected message. Private human answers are stored separately
from public chat and act as private glossary evidence: full-text lookup can reuse
them for that requester on the same message or a later reference in that group.
No request is sent until the newcomer taps **Ask**. Only the original sender
can answer or decline.

## Checks

```sh
uv run pytest
uv run ruff check backend scripts
uv run ruff format --check backend scripts
cd frontend
npm run lint
npm run typecheck
npx expo export --platform web
```

Eight PostgreSQL integration tests run when `TEST_DATABASE_URL` points to a
**disposable PostgreSQL database with pgvector available**. These tests apply the
migration, seed synthetic history, and roll back test-specific writes. Without
it they are skipped; unit tests and health checks still run. They cover context
boundaries and timestamp ties, group isolation, vector/full-text retrieval,
paging, source navigation, private request authorization, opt-in behavior,
citation validation, follow-ups, and Bedrock failure handling.
