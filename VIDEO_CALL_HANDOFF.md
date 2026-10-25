# Video call integration handoff

The call UI now uses the canonical Chime call backend. Creating or joining a call returns a meeting, a distinct attendee and a participant call token. The iOS Expo module connects Chime audio/video, roster events and native transcript events to the React Native screen.

Final transcript events are persisted in Aurora through `/calls/{id}/transcripts`, using stable Chime result IDs to deduplicate writes. The question button flushes pending writes before requesting an explanation. The backend reads stored transcript context and uses Bedrock to return a short explanation with source result IDs. Typed follow-up questions and silence suggestions use the same persisted context. Legacy call endpoints delegate to this service instead of maintaining another transcript table.

## Development

Use Node 22.21.1 (`nvm use` in `frontend`). Expo Go cannot load the custom Chime module; use an iOS development build. Sign the generated Xcode workspace with your Personal Team for local iPhone installation, then run `npx expo start --dev-client --lan` with the phone and Mac on the same network. Native source lives in `frontend/modules/chime-call`; generated `ios/` and `android/` directories are ignored.

The private frontend environment is `frontend/.env.local`, containing `EXPO_PUBLIC_CALLS_API_URL` and the scoped demo key `EXPO_PUBLIC_CALLS_DEMO_KEY`. Generate the values with `uv run python infra/verify_calls.py` and copy `infra/.build/calls-frontend.env` to that file. Neither file belongs in Git. Do not put AWS credentials in the mobile app. Demo and participant token authentication are for the hackathon; other infrastructure routes retain IAM authentication.

## Validation and remaining work

- Backend: `uv run pytest` (28 tests), `uv run ruff check backend infra`.
- Frontend: `npx tsc --noEmit`, `npx expo lint`, `node --experimental-strip-types api-check.mjs`.
- Deployed AWS: `uv run python infra/verify_calls.py` checks real Chime control, Aurora persistence/deduplication, Bedrock context retrieval, access restrictions and meeting cleanup. It uploads synthetic transcripts, not microphone audio.
- The Swift transcript serialization syntax error was fixed and the unused incompatible `expo-av` dependency removed. The latest local simulator build still failed on a `react-native-screens` generated header (`rnscreens/EventEmitters.h`). A successful full native build and two-device microphone/video/transcription test are not verified.
- On two installed devices, create a call on one, join with its invite code on the other, allow microphone/camera access, confirm live captions and no storage error, then ask about a reference just spoken. Check mute, video and host end controls as well.

Spoken private questions and group chat history retrieval are not implemented. The question sheet accepts typed questions. Bedrock request limits are per process, not account-wide spend limits. Model output can still be incorrect.
