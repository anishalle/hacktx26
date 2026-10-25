# API contract

The shared contract between the iOS app (`frontend/`) and the API (`backend/`). Both sides build
against this file; change it here first, then in code.

- Base URL: `http://localhost:8000/api/v1` (the iOS Simulator reaches the Mac at `localhost`).
  The app reads it from `EXPO_PUBLIC_API_URL`.
- All timestamps are ISO 8601 UTC strings. JSON bodies use `snake_case`.
- There is no auth. Every request that acts "as" someone carries `user_id`. The app has a hidden
  demo-user switcher.
- Errors: FastAPI default `{"detail": "..."}` with a 4xx/5xx status.

Feature 1 (hold-to-explain, `/explain/*`, `/ask-member/*`) is owned by another teammate and is not
specified here beyond the tables it shares (see "Data model").

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

The client may send `{ "type": "ping" }`; the server answers `{ "type": "pong" }`.

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

Defined in `backend/app/models.py`, created on startup with `CREATE EXTENSION vector`. Feature 1 owns
filling in `message_windows.embedding` and the `explanations` / `member_asks` flows.

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
| `explanations` | `id, group_id, user_id, message_id, answer jsonb, created_at` (feature 1) |
| `member_asks` | `id, group_id, asked_user_id, for_user_id, term, message_id, status, answer` (feature 1) |
