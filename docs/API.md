# API contract

The shared contract between the iOS app (`frontend/`) and the API (`backend/`). Both sides build
against this file; change it here first, then in code.

- Base URL: `http://localhost:8000/api/v1` (the iOS Simulator reaches the Mac at `localhost`).
  The app reads it from `EXPO_PUBLIC_API_URL`.
- All timestamps are ISO 8601 UTC strings. JSON bodies use `snake_case`.
- There is no auth. Every request that acts "as" someone carries `user_id`. The app has a hidden
  demo-user switcher.
- Errors: FastAPI default `{"detail": "..."}` with a 4xx/5xx status.


## Shapes

```ts
type User = {
  id: string;                 // slug, e.g. "priya"
  username: string;           // Instagram-style handle, e.g. "priya.k"
  display_name: string;       // "Priya Kapoor"
  avatar_url: string | null;  // null → app shows the default gray silhouette
  phonetic_hint: string | null;
  pronunciation_audio_url: string | null;
};

type Reaction = { emoji: string; user_id: string };

type Message = {
  id: number;
  group_id: number;
  sender_id: string | null;   // null when kind == "system"
  kind: "text" | "system";    // system: "aakash added priya", shown centered
  text: string;
  ts: string;
  reply_to: number | null;
  reactions: Reaction[];
};

type Member = {
  user: User;
  joined_at: string;
  last_read_message_id: number | null;
  is_newcomer: boolean;       // joined within NEWCOMER_BADGE_DAYS (default 7); UI hint only
};

type Group = {
  id: number;
  name: string;               // for DMs, the other person's display name from the viewer's side
  avatar_url: string | null;
  is_dm: boolean;
  member_count: number;
};

type GroupDetail = Group & { members: Member[] };

type InboxItem = {
  group: Group;
  last_message: Message | null;
  unread_count: number;       // others' messages after the viewer's last_read_message_id (own messages never count)
  last_read_message_id: number | null;
};

type FlaggedTerm = {
  term: string;               // canonical glossary term, e.g. "Grandma"
  glossary_id: number;
  matched_text: string;       // exactly as typed in the draft, e.g. "grandma's"
  start: number;              // char offsets into the draft (UTF-16, JS string indices)
  end: number;
  meaning: string;
  kind: GlossaryKind;
  newcomer_ids: string[];     // newcomers who joined after this term was last explained
};

type GlossaryKind = "nickname" | "place" | "event" | "slang" | "person" | "inside_joke";

type Span = { start: number; end: number }; // char offsets into the text it belongs to

type GlossaryEntry = {
  id: number;
  group_id: number;
  term: string;
  aliases: string[];
  meaning: string;
  kind: GlossaryKind;
  confidence: number;
  source: "seed" | "auto" | "human";
  first_seen_ts: string;
  last_explained_ts: string | null;
  source_message_ids: number[];
};
```

## Users and inbox

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/users` | | `User[]` (demo users for the switcher) |
| GET | `/users/{user_id}/inbox` | | `InboxItem[]`, newest activity first |

## Groups and messages

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/groups/{group_id}` | `?user_id=` | `GroupDetail` |
| GET | `/groups/{group_id}/messages` | `?before=&after=&around=&limit=50` (max 200) | `{ messages: Message[], has_more_before: boolean, has_more_after: boolean }` |
| POST | `/groups/{group_id}/messages` | `{ sender_id, text, reply_to? }` | `Message` (201); fans out `message.new` |
| POST | `/groups/{group_id}/messages/{message_id}/reactions` | `{ user_id, emoji }` | `Message`; one reaction per user (same emoji removes it, a different one replaces it); fans out `reaction.updated` |
| POST | `/groups/{group_id}/read` | `{ user_id, message_id }` | `204`; fans out `read.updated` |
| GET | `/groups/{group_id}/glossary` | | `GlossaryEntry[]` (debug and feature 1) |

`messages` is always returned in ascending `ts` order. With no cursor it returns the newest `limit`.
`before`/`after` are exclusive message ids. `around` centers the page on that id, which catch-up
uses for "jump to where this happened".

## Realtime

`WS /api/v1/ws?user_id={user_id}` (under the same `/api/v1` prefix as everything else). The server pushes JSON frames `{ "type": string, "data": object }` for
every group the user is in:

| type | data |
| --- | --- |
| `message.new` | `Message` |
| `reaction.updated` | `{ group_id, message_id, reactions: Reaction[] }` |
| `read.updated` | `{ group_id, user_id, message_id }` |
| `ask.new` | `MemberAsk`, sent only to the member being asked |
| `ask.updated` | `MemberAsk`, sent to both people on the ask when it is answered or declined |
| `call.updated` | `Call`, sent to every group member when a call starts, someone joins or leaves, or it ends |

The client may send `{ "type": "ping" }`; the server answers `{ "type": "pong" }`.

## Feature 1: hold-to-explain

Long-press a message → **Explain** opens a private sheet. Catch-up term chips open the same sheet
with a bare `term`. Nothing is posted to the group, and nobody else sees that the user asked.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| POST | `/explain` | `{ group_id, user_id, message_id?, term?, explanation_id?, follow_up? }` | `Explanation` |
| POST | `/ask-member` | `{ group_id, user_id, term, message_id? }` | `MemberAsk` (201); pushes `ask.new` |
| GET | `/users/{user_id}/asks` | | `{ incoming: MemberAsk[], outgoing: MemberAsk[] }`, newest first |
| POST | `/ask-member/{ask_id}/answer` | `{ user_id, answer?, decline?, post_in_chat? }` | `MemberAsk`; pushes `ask.updated` |

- `/explain` needs `message_id` or `term`. A follow-up sends `explanation_id` (from the first answer)
  plus `follow_up`; it reuses that explanation's context and only works for the user who asked.
- `/ask-member` is the newcomer's explicit opt-in. The server picks who to ask: the message's sender,
  else the member who uses the term most. Asking again while one is pending returns the same ask.
- Only the asked member can answer, once. `answer` saves the term to the glossary with
  `source: "human"` (feature 2 sees it too). `post_in_chat: true` also sends the answer to the group
  as a normal message from them. `decline: true` passes without answering.

```ts
type ExplainStatus =
  | "no_speech"   // calls only: nothing was said in the last 45 s
  | "explained"   // grounded in this group's history
  | "general"     // not defined in this chat; common slang from general knowledge (label it so)
  | "plain"       // nothing unusual; the sheet offers catch-up instead
  | "unknown";    // no reliable explanation; the sheet offers `ask`

type Explanation = {
  explanation_id: number;     // pass back with follow_up
  group_id: number;
  message_id: number | null;
  term: string | null;        // main term, null when plain
  status: ExplainStatus;
  kind: GlossaryKind | "plain" | "unknown";
  meaning: string;            // 1-3 short sentences; terms wrapped in **double asterisks**
  confidence: number;         // 0-1
  follow_up: string | null;   // the question this answers, for follow-ups
  sources: Message[];         // up to 3 evidence messages, oldest first; tap → thread around=id
  human_sources: { ask_id: number; user: User; answer: string; answered_at: string }[];
  person: User | null;        // kind "person" naming a member: show their profile card
  ask: { user: User; existing: MemberAsk | null } | null; // unknown/general: who to ask privately
  // Calls only (feature 4); null for messages and terms:
  call_id: number | null;
  said_by: User | null;       // who said the explained phrase on the call
  heard: string | null;       // status unknown on a call: the words it caught, e.g. "…getting procs…"
};

type MemberAsk = {
  id: number;
  group_id: number;
  group_name: string;
  term: string;
  message: Message | null;    // the message the newcomer held on
  for_user: User;             // the newcomer who asked
  asked_user: User;
  status: "pending" | "answered" | "declined";
  answer: string | null;
  posted_message_id: number | null; // set when answered with post_in_chat
  created_at: string;
  answered_at: string | null;
};
```

Server design (not part of the contract): the model sees the pressed message with its 20
neighbours, the glossary entries it mentions, and up to 8 retrieved windows (full-text and
embedding hits fused by rank, preferring definitional and pre-join messages), about 4k tokens.
Every answer must cite supplied message, glossary or private-answer ids; uncited or low-confidence
(< 0.4) answers become `unknown`. Windows of 10 messages are embedded with Bedrock Titan v2 in the
background; without AWS credentials retrieval falls back to full-text only.

## Feature 4: live ? on a group call

Calls run on Amazon Chime. The server creates the meeting and one attendee per member; Chime
carries audio/video and live transcription (Amazon Transcribe) to every participant through the
iOS bridge in `frontend/modules/chime-call` (needs an Expo dev build, not Expo Go). Each client
forwards **final** transcript results here. The **?** button explains what was just said, privately,
with the feature 1 pipeline over the call transcript **and** the group's chat history.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/groups/{group_id}/call` | | `Call \| null`, the group's active call |
| POST | `/groups/{group_id}/call` | `{ user_id }` | `CallJoin`: starts a call (with transcription) or joins the active one; pushes `call.updated` |
| POST | `/calls/{call_id}/leave` | `{ user_id }` | `Call`; the last member out ends it (the Chime meeting is deleted); pushes `call.updated` |
| POST | `/calls/{call_id}/transcripts` | `{ user_id, results: ChimeResult[] }` (max 50) | `{ stored: number }` |
| POST | `/calls/{call_id}/explain` | `{ user_id, at_ms, pending_results?: ChimeResult[] }` (max 20) | `Explanation` |

- Every participant may forward the same finals: `(call_id, resultId)` deduplicates, and a late
  partial never overwrites a final. Partials are only for on-screen captions.
- `at_ms` is `Date.now()` frozen at the tap (epoch ms). The focus is the 45 s before it, with the
  2 minutes before that as background. `pending_results` carries finals (and the current partial)
  not uploaded yet, so the tap never races an upload.
- Follow-ups on a call card use `POST /explain` with the returned `explanation_id`, like feature 1.
- Chime's `externalUserId` is our user id, so transcript lines and `said_by` map to members.

```ts
type Call = {
  id: number;
  group_id: number;
  started_by: string;
  started_at: string;
  ended_at: string | null;
  members: { user: User; attendee_id: string; joined_at: string; left_at: string | null }[];
};

type CallJoin = {
  call: Call;
  meeting: object;   // Chime CreateMeeting "Meeting" (MeetingId, MediaRegion, MediaPlacement, ...)
  attendee: object;  // Chime CreateAttendee "Attendee" (AttendeeId, ExternalUserId, JoinToken)
};

type ChimeResult = {  // exactly what the native module emits
  resultId: string;
  isPartial: boolean;
  startTimeMs: number; // epoch ms
  endTimeMs: number;
  alternatives: {
    transcript: string;
    items: {
      type: "pronunciation" | "punctuation";
      content: string;
      startTimeMs: number;
      endTimeMs: number;
      attendee: { attendeeId: string; externalUserId: string };
    }[];
  }[];
};
```

## Feature 2: pre-send clarity nudge

Flow in the composer:

1. About 800 ms after the last keystroke, call `POST /nudge/check`. It does no LLM call, just
   glossary matching, and answers in about 50 ms. If `show`, render the banner above the composer
   with `message` and two buttons, **Rewrite** and **Keep mine**. Never block send.
2. **Rewrite** → `POST /nudge/rewrite`. Replace the draft with `rewritten` and briefly highlight
   `changes`. The member can keep editing.
3. **Keep mine** → `POST /nudge/dismiss` for each flagged term (remembered per member × group ×
   term; that term never nudges them again in this group).
4. On **send** tap, if no banner is showing and the group has newcomers, call `POST /nudge/unknown`
   with a 3 s client timeout. If it returns `show`, hold the send, show the "inside reference"
   banner and change the send button to **Send anyway**. On timeout or error, send normally.
5. On that banner, **Add aside** opens a one-line field "What does “X” mean?" →
   `POST /nudge/aside`, which weaves the explanation into the draft and saves it to the glossary
   (`source: "human"`) so the next newcomer is covered too.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/nudge/check` | `{ group_id, user_id, draft }` | `NudgeCheck` |
| POST | `/nudge/rewrite` | `{ group_id, user_id, draft, terms: string[] }` | `{ rewritten: string, changes: Span[] }` |
| POST | `/nudge/unknown` | `{ group_id, user_id, draft }` | `NudgeUnknown` |
| POST | `/nudge/aside` | `{ group_id, user_id, draft, term, meaning }` | `{ rewritten: string, changes: Span[], glossary_id: number }` |
| POST | `/nudge/dismiss` | `{ group_id, user_id, term }` | `204` |

```ts
type NudgeCheck = {
  show: boolean;
  flagged_terms: FlaggedTerm[];
  newcomers: { user_id: string; display_name: string; joined_at: string }[];
  message: string | null; // 'Priya joined 2 days ago and might not know "Grandma" or "usual spot." Rewrite for her?'
};

type NudgeUnknown = {
  show: boolean;
  unknown_terms: { term: string; start: number; end: number }[];
  newcomers: { user_id: string; display_name: string; joined_at: string }[];
  message: string | null; // "This looks like an inside reference and I can't find where it's explained. Priya probably doesn't know it. Add a quick aside?"
};
```

Rules the server enforces:

- A term is flagged only if some member other than the sender has `joined_at` after the term's
  origin, `coalesce(last_explained_ts, first_seen_ts)`.
- Dismissed terms (`nudge_dismissals`) are never flagged for that sender in that group.
- The rewrite keeps the member's voice: it adds a short parenthetical or clause and doesn't change
  the tone.

## Feature 3: catch-up

The pill shows at the top of the thread when `unread_count >= 50`:
**Catch me up (1,204 unread)**. Tapping it opens a native iOS sheet and streams the summary.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/groups/{group_id}/catchup/preview` | `?user_id=` | `{ unread_count, since_message_id, eligible }` |
| POST | `/catchup` | `{ group_id, user_id, since_message_id? }` | `text/event-stream` (below) |
| POST | `/catchup?stream=false` | same | `CatchupResult` JSON |
| POST | `/catchup/ask` | `{ group_id, user_id, since_message_id?, question }` | `{ answer: string, sources: { start_message_id, end_message_id }[] }` |

`since_message_id` defaults to the user's `last_read_message_id`, or else the first message after
their `joined_at`. Catch-up never changes read state.

SSE events, in order (each is `event: <name>\ndata: <json>\n\n`):

| event | data |
| --- | --- |
| `meta` | `{ unread_count, since_message_id, until_message_id }` |
| `bullet` | `CatchupBullet`, repeated as the model produces them |
| `term` | `{ term, glossary_id, meaning }`, terms in the range the newcomer may not know |
| `done` | `{ elapsed_ms }` |
| `error` | `{ message }` |

```ts
type CatchupBullet = {
  section: "happened" | "decisions" | "open";
  text: string;
  start_message_id: number;   // tap → open the thread at `around=start_message_id`
  end_message_id: number;
};

type CatchupResult = {
  unread_count: number;
  since_message_id: number;
  until_message_id: number;
  bullets: CatchupBullet[];
  terms: { term: string; glossary_id: number; meaning: string }[];
};
```

The client uses `fetch` from `expo/fetch`, which supports streaming response bodies, and parses the
SSE frames itself.

Server design (not part of the contract): every 100 messages in a group are summarized in the
background into `chunk_digests` as they arrive. At tap time the server only runs the reduce step
over the digests in range plus the raw undigested tail, so the first bullet appears in about 2 s.

## Data model

Defined in `backend/app/models.py`, created on startup with `CREATE EXTENSION vector`.

| Table | Key fields |
| --- | --- |
| `users` | `id (slug), username, display_name, avatar_url, phonetic_hint, pronunciation_audio_url` |
| `groups` | `id, name, avatar_url, is_dm, created_at` |
| `memberships` | `group_id, user_id, joined_at, last_read_message_id` |
| `messages` | `id, group_id, sender_id, kind, text, ts, reply_to, tsv (generated tsvector, GIN)` |
| `reactions` | `message_id, user_id, emoji` |
| `message_windows` | `id, group_id, start_message_id, end_message_id, text, embedding vector(EMBEDDING_DIM)` |
| `glossary` | `id, group_id, term, aliases text[], meaning, kind, confidence, source (seed/auto/human), first_seen_ts, last_explained_ts, source_message_ids bigint[]` |
| `nudge_dismissals` | `user_id, group_id, term` |
| `chunk_digests` | `id, group_id, start_message_id, end_message_id, start_ts, end_ts, message_count, digest jsonb` |
| `explanations` | `id, group_id, user_id, message_id, answer jsonb (answer + context snapshot), created_at` |
| `member_asks` | `id, group_id, asked_user_id, for_user_id, term, message_id, status, answer, posted_message_id, created_at, answered_at` |
| `calls` | `id, group_id, meeting_id, meeting jsonb, started_by, started_at, ended_at` |
| `call_members` | `call_id, user_id, attendee_id, joined_at, left_at` |
| `call_transcripts` | `call_id, result_id, speaker_id, start_ms, end_ms, text, items jsonb, is_partial` |
