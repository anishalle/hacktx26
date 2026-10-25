# Video call frontend and AI handoff

The product brief is `DESIGN.md`. The call feature helps a newcomer understand recent speech without interrupting the group.

## Current behavior

- Mobile home and call preview use neutral surfaces, restrained blue accents, and text controls without emoji.
- The blue assistant blob responds to touch, sways while idle, changes expression while thinking, and respects reduced motion.
- Tap collects the last 10 seconds of available transcript. Hold opens a private typed question with up to two minutes of context.
- The previous mute selection is restored after submitting or cancelling. These are UI states until a call transport is connected.
- No simulated transcript runs automatically. No random explanation or canned suggestion is substituted for API failure.
- Empty transcript requests do not invoke Bedrock. Requests time out, duplicate explanation requests are ignored, and suggestion retries have a 90-second cooldown.
- Speaker-tagged utterances can enter through `useCallTranscript.addUtterance`; failed saves are exposed by `storageError`.
- Backend uses the Bedrock Converse contract and evidence-only prompts. No chat history is currently retrieved, and prompts explicitly say that.
- Input budgets reject oversized prompts instead of truncating away instructions. Output caps and per-process request limits remain in place; retries are disabled. These are not account-wide spend limits.

## Not yet connected

1. A real video transport, remote audio volume control, and microphone mute API.
2. Speech recognition and a reliable mapping from audio tracks to participant IDs. Speaker highlighting is not speaker identification.
3. Spoken private questions. The current sheet accepts typed input.
4. Group-history retrieval, embeddings, and source citations. Prompting alone cannot guarantee factual model output.
5. Production API authentication. The infrastructure requires AWS SigV4; the mobile fetch client currently does not sign requests. Use a teammate-owned authentication flow, never embed IAM secrets in the app.
6. Transcript table creation/migration. `init_schema` exists but is not called. Provision through the backend owner's migration process.

The screen is explicitly labeled Preview while those integrations are absent. Silence suggestions stay inactive without real transcript data. The original mock utility remains available as an unused development fixture.

## Local checks

From `frontend`: `npx tsc --noEmit`, `npx expo lint`, `npx expo export --platform web`, and `node --experimental-strip-types api-check.mjs`.

From the repository root: `uv run pytest` and focused Ruff checks on `backend/app/core/bedrock.py`, `backend/app/api/routes/call.py`, and `backend/tests/test_call.py`.

Backend tests replace AWS clients with mocks. API client checks replace fetch. Neither invokes paid models.

## AWS verification boundary

The local default AWS identity points to a different account from the one specified in `infra/README.md`, and is a root identity. Only STS identity discovery was performed. No deployment, database writes, inference, or embedding calls were made.

Do not use `infra/verify.py` as a read-only check: it creates an extension, writes an S3 object, publishes an event, and invokes generation and embedding models. Live verification must use the intended project identity and a deliberately bounded probe.
