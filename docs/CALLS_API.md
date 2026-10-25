# Chime call backend: frontend contract

Base URL: `https://tq3imyqav7.execute-api.us-east-1.amazonaws.com/api/v1`

Calls use ordinary HTTPS, not AWS-signed requests. Other app routes retain their
existing IAM authentication. This is prototype authentication: anyone with the
shared demo key can create or join a demo call, with self-selected user/group IDs.
It is not production user authentication or group membership verification.

The shared demo key lives in Secrets Manager; get its ARN from the stack output
`CallsDemoKeySecretArn`. The local ignored `infra/.build/calls-frontend.env` contains
the frontend URL and demo key after the deployed smoke test. Share that file with
the frontend teammate, not AWS credentials. Never commit it.

## 1. Create or join

Host calls `POST /calls`, with header `X-Demo-Key: <shared key>`:

```json
{"group_id":"demo-group","user_id":"sunay"}
```

Response:

```json
{
  "call_id":"<uuid>",
  "meeting":{"MeetingId":"...","MediaPlacement":{}},
  "attendee":{"AttendeeId":"...","ExternalUserId":"...","JoinToken":"..."},
  "call_token":"<participant-specific token>",
  "is_host":true
}
```

`meeting` and `attendee` are the original AWS objects, including all placement
fields needed by Chime. Pass them into your native Chime meeting configuration.
Treat attendee join tokens and call tokens as credentials; keep them out of logs.

Other participants call `POST /calls/{call_id}/join` with `X-Demo-Key` and:

```json
{"user_id":"teammate"}
```

They receive the same shape with their own attendee/join token and call token.
Do not share the host's call token. Preserve a participant's existing session
while reconnecting instead of calling join on every component render.

Chime is a native dependency in React Native: use an Expo development build and
a bridge exposing both meeting audio/video and transcript events. The web Chime
JavaScript SDK's callback sample below is not a drop-in React Native SDK.

## 2. Start live transcription

After everyone joins and knows transcription is enabled, the host calls:

```text
POST /calls/{call_id}/transcription/start
X-Call-Token: <host call token>
```

Response: `{"status":"requested"}`. This means AWS accepted the request, not
that transcription has already started. The frontend must observe Chime's
`started`, `failed`, `interrupted`, `resumed`, and `stopped` status events.
Configuration is English (`en-US`) with medium partial-result stabilization.

Audio travels through Chime to Transcribe. The FastAPI backend does not receive
or record raw audio. Chime delivers transcript events to meeting participants.

## 3. Forward transcript events

Subscribe to Chime transcript events through the call SDK/bridge. On the web SDK
the corresponding API is:

```ts
audioVideo.transcriptionController?.subscribeToTranscriptEvent(onTranscript);
```

For an event with `results`, forward its finalized results to:

```text
POST /calls/{call_id}/transcripts
X-Call-Token: <your call token>
```

```json
{
  "results":[{
    "resultId":"chime-result-id",
    "isPartial":false,
    "startTimeMs":1792889000000,
    "endTimeMs":1792889001000,
    "alternatives":[{
      "transcript":"Grandma's after the game.",
      "items":[]
    }]
  }]
}
```

Forward the actual `items` array too: word timestamps and attendee attribution
allow precise clipping when a sentence spans the ten-second cutoff. Extra Chime
fields are ignored. Timestamps are **Unix epoch milliseconds**, not elapsed call
time. The sample times above are illustrative; submit actual event timestamps.
Results dated before the call or in the future are rejected.

Keep partials in the frontend for captions and the question button. Normal
transcript ingestion ignores partials. Flush finals in short batches (up to 50
results), rather than making one HTTP request for every partial update.
All clients may forward finals: `(call_id, result_id)` deduplicates repeated
events. A final result cannot be overwritten by a late partial.

`GET /calls/{call_id}/transcripts?since_ms=<epoch-ms>&at_ms=<epoch-ms>` with the
call token returns up to the latest 200 stored results in chronological order.

## 4. Question-mark button

Freeze `Date.now()` when tapped. Send:

```text
POST /calls/{call_id}/explain
X-Call-Token: <your call token>
```

```json
{
  "at_ms":1792889002000,
  "pending_results":[]
}
```

Include the latest unsent final/partial Chime results in `pending_results` (up to
20), so pressing the button does not race a delayed transcript upload. Keep the
same `at_ms` while awaiting/retrying the request. The backend clips by that time,
not the time it finishes processing.

Response:

```json
{
  "answer":"Grandma's means Swayam's house, where the group is meeting.",
  "status":"explained",
  "source":"conversation",
  "source_result_ids":["earlier-definition-result-id"]
}
```

Show `answer` privately over the call. `status` can also be `unclear` or
`no_recent_speech`. There is no audio interruption or group broadcast.

The last ten seconds are the focus; up to two minutes of earlier call transcript
provide background. This version does not query text-chat history or the text
team's glossary yet. A nickname can be explained if someone defined it in that
call context. General slang is labeled `general_language`; unsupported personal
references return `unclear`, rather than invented identities or locations.

## 5. End

Host calls `POST /calls/{call_id}/end` with their call token. This deletes the
Chime meeting, which also ends its transcription, and marks the call ended in SQL.
Participants can still retrieve stored context using their tokens. Repeated end
requests are safe. Implement leaving on the frontend separately from ending for
everyone; a non-host cannot end the meeting or start transcription.

## Errors

- `401`: missing/wrong demo key or missing call token.
- `403`: invalid call token or host-only action by another participant.
- `409`: operation requires an active call, but it has ended.
- `410`: the underlying Chime meeting is gone.
- `422`: invalid payload or timestamp. Check phone clock and use epoch millis.
- `502` / `503`: AWS/model failure or throttling; allow a manual retry.

## Backend development

`bash infra/deploy.sh` deploys code/permissions and applies the additive call
schema. `python3 infra/migrate_calls.py` reapplies just the schema safely.
Local development requires AWS credentials plus the `.env.example` settings;
use a CLI credential-process profile if your SDK cannot read `aws login` sessions.

Tests: `uv run pytest`. The deployed smoke test uses synthetic transcript events:
`uv run python infra/verify_calls.py`. It verifies Chime control APIs, SQL,
deduplication, authorization and Bedrock; it does not prove microphone audio or
native frontend transcript forwarding. Test that with two real devices.

The smoke test reuses HTTPS connections and retries connection/TLS setup failures
twice. It does not retry read timeouts or server errors, which could otherwise
duplicate a call or attendee after a request was already processed. TLS certificate
verification stays enabled.
