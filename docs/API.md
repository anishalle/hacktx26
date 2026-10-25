# API contract

The shared contract between the iOS app (`frontend/`) and the API (`backend/`). Both sides build
against this file; change it here first, then in code.

- Base URL: `https://hacktx26.anishalle.com/api/v1`, the shared dev API on the homelab (the app's
  default). For a local backend use `http://localhost:8000/api/v1` via `EXPO_PUBLIC_API_URL`.
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
  about: string | null;       // who they are in a line or two ("Dad. 52, engineer. ..."); explanations are written for it
};

type Reaction = { emoji: string; user_id: string };

type Message = {
  id: number;
  group_id: number;
  sender_id: string | null;   // null when kind == "system"
  kind: "text" | "system" | "photo" | "game"; // system: "aakash added priya", shown centered; game: feature 7
  text: string;
  ts: string;
  reply_to: number | null;
  image: { url: string; width: number; height: number } | null; // kind "photo"; text is its caption ("" if none)
  image_description: string | null; // the AI's description of the photo (alt text); null until ready
  reactions: Reaction[];
  game: LoreGame | null;      // kind "game" (feature 7), as the viewer sees it; null otherwise
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
| GET | `/users/{user_id}/inbox` | | `InboxItem[]`, newest activity first (a game `last_message` carries its `game`) |

## Groups and messages

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/groups/{group_id}` | `?user_id=` | `GroupDetail` |
| GET | `/groups/{group_id}/messages` | `?before=&after=&around=&limit=50` (max 200), `&user_id=` (the viewer: fills each game's `my_vote` and `can_reveal`) | `{ messages: Message[], has_more_before: boolean, has_more_after: boolean }` |
| POST | `/groups/{group_id}/messages` | `{ sender_id, text, reply_to? }` | `Message` (201); fans out `message.new` |
| POST | `/groups/{group_id}/photos` | multipart: `file` (JPEG or PNG, ≤ 15 MB), `sender_id`, `text?` (caption), `reply_to?` | `Message` with `kind: "photo"` (201); fans out `message.new` |
| POST | `/groups/{group_id}/messages/{message_id}/reactions` | `{ user_id, emoji }` | `Message`; one reaction per user (same emoji removes it, a different one replaces it); fans out `reaction.updated` |
| POST | `/groups/{group_id}/read` | `{ user_id, message_id }` | `204`; fans out `read.updated` |
| GET | `/groups/{group_id}/glossary` | | `GlossaryEntry[]` (debug and feature 1) |

Photos are stored on the server (re-encoded as JPEG, at most 1600 px, metadata such as location
stripped) and served from `image.url` (absolute). Right after upload the server asks Muse to describe
the photo (what it shows plus any visible text) and saves that as `image_description`; from then on
every AI feature sees the photo as `[photo: <description>] <caption>` wherever it reads chat history:
search, embeddings, explanations (holding a photo explains it), catch-up and the call ? button.

`messages` is always returned in ascending `ts` order. With no cursor it returns the newest `limit`.
`before`/`after` are exclusive message ids. `around` centers the page on that id, which catch-up
uses for "jump to where this happened".

## Realtime

`WS /api/v1/ws?user_id={user_id}` (under the same `/api/v1` prefix as everything else). The server pushes JSON frames `{ "type": string, "data": object }` for
every group the user is in:

| type | data |
| --- | --- |
| `message.new` | `Message` |
| `message.updated` | `Message`, the whole message again when it changes; replace it by `id`. Today: a game message on every vote, hint or reveal, sent to each member with the game as they see it (feature 7) |
| `reaction.updated` | `{ group_id, message_id, reactions: Reaction[] }` |
| `read.updated` | `{ group_id, user_id, message_id }` |
| `ask.new` | `MemberAsk`, sent only to the member being asked |
| `ask.updated` | `MemberAsk`, sent to both people on the ask when it is answered or declined |
| `call.updated` | `Call`, sent to every group member when a call starts, someone joins or leaves, or it ends |
| `call.caption` | `CallCaption`, sent to every member on the call as someone speaks (feature 4) |
| `lore.updated` | `Lore` (feed-sized, `pinned` and `is_me` for the receiving user), sent to the group when a moment is suggested, kept, dismissed or removed (feature 6). A call suggestion (`source: "call"`, `status: "suggested"`) goes only to the people on that call; a pin or unpin goes only to the member who did it |

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
  lore: Lore[];               // kept lore this term/message belongs to (max 2): show "See the lore"
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

Calls run on Amazon Chime for audio and video only, through the iOS bridge in
`frontend/modules/chime-call` (needs an Expo dev build, not Expo Go). Captions come from Meta's
Muse realtime speech-to-text: **each phone streams only its own microphone** to the API over a
WebSocket, so every caption belongs to exactly one member. The API relays the audio to Muse, fans
the growing transcript out to the call as `call.caption`, and stores each finished turn. The **?**
button explains what was just said, privately, with the feature 1 pipeline over the call
transcript **and** the group's chat history.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/groups/{group_id}/call` | | `Call \| null`, the group's active call |
| POST | `/groups/{group_id}/call` | `{ user_id }` | `CallJoin`: starts a call or joins the active one; pushes `call.updated` |
| POST | `/calls/{call_id}/leave` | `{ user_id }` | `Call`; the last member out ends it (the Chime meeting is deleted); pushes `call.updated` |
| WS | `/calls/{call_id}/audio?user_id=` | binary audio frames (below) | JSON status frames (below) |
| POST | `/calls/{call_id}/explain` | `{ user_id, at_ms }` | `Explanation` |

Audio WebSocket (`wss://…/api/v1/calls/{call_id}/audio?user_id=…`, one per participant):

- Client → server: binary frames of mono **PCM16 little-endian at 24 kHz**, about 80 ms each
  (3,840 bytes), sent in real time from joining until leaving. While muted, send silence (zeros)
  instead of stopping: the stream must keep real-time pace or Muse closes it.
- Server → client: `{ "type": "ready" }` once transcription is live, `{ "type": "error", "message" }`
  if it fails. The server reconnects to Muse on its own (sessions last up to 60 minutes); the client
  only reconnects if the socket itself closes.

`call.caption` frames go to every member on the call (the speaker included) over the main `/ws`:

```ts
type CallCaption = {
  call_id: number;
  user_id: string;   // whose microphone this came from
  turn_id: string;   // one spoken turn; text is cumulative within it
  text: string;      // the whole turn so far, e.g. "grandmas after the" → "grandmas after the game."
  final: boolean;    // true once the turn is complete (then stored for the ? button)
  ts: string;        // when this update was produced
};
```

- `at_ms` is `Date.now()` frozen at the tap (epoch ms). The focus is the 45 s before it, with the
  2 minutes before that as background; turns still in progress count up to the tap.
- Follow-ups on a call card use `POST /explain` with the returned `explanation_id`, like feature 1.

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
  attendee: object;  // Chime CreateAttendee "Attendee" (AttendeeId, ExternalUserId = our user id, JoinToken)
};
```

## Feature 6: Lore

A group's kept moments: things that happened (an inside joke being born, the Incident, a trip).
Each has an AI **title** (the only model-written text Lore serves), who was there, and its
**events**: each photo, each call replay, or, when it has neither, its most-reacted message as a
**quote**. Every event carries **snippets**: the real lines people sent or said around it.
Moments are found automatically (chat and calls) and **suggested**; any member taps **Keep**
(first tap wins for the group) or dismisses. Kept lore shows in the Lore feed (the Reels tab)
across all your groups. Any member can remove a kept entry; pins are per member. Backfill over
existing history keeps the strongest moments automatically.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/users/{user_id}/lore` | `?group_id=&kind=photo\|replay\|quote&pinned=true&sort=deck\|recent&q=&cursor=&limit=20` (max 50) | `LoreFeed`: kept lore in the user's groups (below) |
| GET | `/lore/{lore_id}` | `?user_id=` | `LoreDetail` (any status; members only) |
| GET | `/groups/{group_id}/lore/suggestions` | `?user_id=` | `Lore[]`: chat suggestions still waiting (`status: "suggested"`, `source: "chat"`) |
| POST | `/groups/{group_id}/lore` | `{ user_id, message_id }` | `Lore`, "Save to Lore" on a text or photo message (system: 400): Muse titles the moment around it (±15 min) and it is kept at once by `user_id`, or merged into kept lore it matches. A message already in kept lore returns that lore; one in a suggestion keeps it. Pushes `lore.updated` |
| POST | `/lore/{lore_id}/keep` | `{ user_id }` | `Lore`; suggested → kept (already kept: returned as is; dismissed: 409). A kept call replay that matches existing lore is attached to it and that lore is returned. Pushes `lore.updated` |
| POST | `/lore/{lore_id}/dismiss` | `{ user_id }` | `Lore`; suggested → dismissed. Pushes `lore.updated` |
| POST | `/lore/{lore_id}/remove` | `{ user_id }` | `Lore`; kept → removed. Pushes `lore.updated` |
| POST | `/lore/{lore_id}/pin` | `{ user_id }` | `Lore` with `pinned: true` (kept lore only, else 409; pinning twice is fine). Pushes `lore.updated` to that user only |
| DELETE | `/lore/{lore_id}/pin` | `?user_id=` | `Lore` with `pinned: false`. Pushes `lore.updated` to that user only |

Feed query:

- `kind`: lore with a photo event (`photo`), a replay event (`replay`), or a quote (`quote`, the
  moments with no media). `pinned=true`: only the user's pins. `q`: title contains (case-insensitive).
- `sort=recent` (default): newest moment first. `sort=deck`: the user's pins first (newest pin
  first), then by `0.6·score + 0.25·recency + 0.15·media`, where score gets +0.1 when the moment
  has media, recency halves every 14 days, and media is 1 for a photo, 0.8 for a replay, 0 for a
  quote. The deck cursor is an offset (`deck:<n>`); keep passing `next_cursor` back as is.
- `counts` respect `group_id` and `q` but not `kind`, `pinned` or the cursor, so the chips can show them.

```ts
type LoreStatus = "suggested" | "kept" | "dismissed" | "removed";

type LoreReplay = {
  id: number;
  call_id: number;
  audio_url: string;          // WAV (24 kHz mono), absolute
  duration_ms: number;
  started_at: string;         // wall-clock start of the clip
  captions: { user_id: string; text: string; start_ms: number; end_ms: number }[]; // offsets into the clip
};

type LoreSnippet = {
  message_id: number | null;  // null for spoken lines (tap → thread around=id)
  user: User | null;
  text: string;               // at most 140 characters
  ts: string;
  reactions: Reaction[];
  reason: "caption"           // the photo's own caption (always first)
    | "reply"                 // replies to the photo / quote
    | "key"                   // one of the moment's key messages
    | "reaction"              // reacted to, right after
    | "spoken"                // said on the call, around the replay's signal
    | "after";                // sent right after (for a replay: in the 10 min after the call)
  start_ms: number | null;    // spoken lines: offset into the replay (tap → seek)
  is_me: boolean;             // sent or said by the requesting user
};

type LoreEvent = {
  kind: "photo" | "replay" | "quote" | "video"; // video: reserved, never sent yet
  at: string;
  message: Message | null;    // photo / quote: the anchor message
  replay: LoreReplay | null;  // replay
  snippets: LoreSnippet[];    // oldest first; photo ≤ 4 (caption included), quote ≤ 4,
                              // replay ≤ 3 speaker turns + ≤ 2 chat lines
};

type Lore = {
  id: number;
  group_id: number;
  group_name: string;
  title: string;              // ≤ 48 chars, who + what: "Mike sets off the ramen alarm again"
  status: LoreStatus;
  source: "chat" | "call";
  call_id: number | null;     // call suggestions: the call it came from
  started_at: string;
  ended_at: string;
  people: User[];
  terms: { term: string; glossary_id: number | null }[]; // tap → explain the term
  hero_kind: LoreEvent["kind"]; // events[0].kind ("quote" when there are no events)
  events: LoreEvent[];        // events[0] is the hero, the rest oldest first (≤ 6 per moment).
                              // Feed, suggestions, related and frames: ≤ 3 events, ≤ 3 snippets each.
                              // LoreDetail: all of them.
  media: Message[];           // up to 6 photo messages, oldest first (the image row)
  cover: { photo: Message | null; replay: LoreReplay | null }; // from events[0]; both null = quote
  anchor_message_id: number | null; // chat suggestions: show the Keep card after this message
  message_count: number;
  photo_count: number;
  replay_count: number;
  kept_by: User | null;       // null for backfilled lore
  kept_at: string | null;
  pinned: boolean;            // pinned by the requesting user
};

type LoreDetail = Lore & {
  messages: Message[];        // key messages, oldest first (tap → thread around=id)
  photos: Message[];          // kind "photo"
  replays: LoreReplay[];
  related: Lore[];            // up to 6 kept lore in the same group, most related first
};

type LoreFeed = {
  items: Lore[];
  next_cursor: string | null;
  counts: { photo: number; replay: number; quote: number; pinned: number };
};
```

The hero is the photo Muse picked as showing the moment best, else the most-reacted photo, else
the first replay, else the quote (the most-reacted key message, earliest on ties).

Server design (not part of the contract): chat moments come from Muse reading raw lines (backfill
over the whole history, and quick triggers on recent messages: message bursts, reaction piles,
photo clusters). It writes a title and a story from the supplied lines only, picks key messages
(every photo included) and a hero photo. The story is stored and embedded but never served: a
candidate that matches existing lore by embedding is attached to it instead of duplicating it,
and related lore is found the same way. Events are computed without a model (`_events` in
`app/services/lore.py`) and stored in `lore.events`, recomputed whenever the evidence changes:

- Photo: text lines in the 40 messages / 15 min after it, plus replies to it within a day. Each
  line belongs to the photo it replies to, else the nearest photo before it. Score: reply +3, key
  message +2, +1 per reaction (up to 3), not the photo's sender +1, an inside term +0.5,
  emoji-only or laughter +1, logistics ("ok", "omw", "what time", ...) or under 3 characters −2,
  −0.1 per minute from the photo (up to 15). The best lines scoring above 0 are kept: at most 2
  per sender, at least one from someone else when there is one.
- Replay: the caption lines overlapping 8 s before to 4 s after the signal (4 s before the clip
  ends), merged into speaker turns (the 3 nearest), plus up to 2 chat lines from the 10 min after
  the call scoring at least 2.
- Quote: its replies, then the other key messages, scored the same way.

On a call the server keeps the last ~30 s of everyone's mic audio (mixed) and captions; signals
(3+ people talking at once, a loudness spike against the call's baseline, a ? tap, phrases like
"no way" / "remember when", glossary terms said aloud) save a replay a few seconds later, at most
one per moment.

## Feature 7: Guess that Lore

A guessing round played in the chat like a poll. Any member starts one (the Game app in the
apps strip): a `game` message lands for everyone showing a kept moment of this group with the
names masked ("Someone's 59.7 MPG Victory Lap") and "Who was it?" with 2-4 members to pick from.
Each member votes once (changeable until the reveal); anyone can unlock the next of 3 shared
hints. It reveals when every member has voted, when the starter taps Reveal, or when anyone does
24 h after it started; a `system` message then posts "🎉 It was Dad: Dad's 59.7 MPG Victory Lap"
(a family member is named by the relation their `about` starts with, else by first name).
Names, usernames, nickname glossary terms and kinship words (Dad, Mom, Thatha...) are masked in
the prompt and hints. Votes, hints and reveals on one game are serialized (row lock), so a round
reveals once. Game messages reach the AI as "Guess that Lore: <prompt> (about lore #N)" and are
left out of Lore detection; talk within 30 min of a round that matches its lore merges into it.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| POST | `/groups/{group_id}/games` | `{ user_id }` | `Message` with `kind: "game"`, text "Guess that Lore 🎲" (201). Picks a random kept lore of this group with a member in it, preferring ones not used in the group's last 5 games; 409 when there is none (or the group has one member), 403 for a non-member. Fans out `message.new` per member |
| POST | `/games/{game_id}/vote` | `{ user_id, choice }` | `Message`; `choice` is an option's user id (else 422). Voting again replaces the vote. The last member's vote reveals. 409 once revealed |
| POST | `/games/{game_id}/hint` | `{ user_id }` | `Message`; the next hint is shown to everyone. 409 when none are left or once revealed |
| POST | `/games/{game_id}/reveal` | `{ user_id }` | `Message`; the starter any time, anyone once every member voted or 24 h passed (else 403). 409 once revealed. Also posts the `system` line |

Every change fans out `message.updated` with the game message to each member, as they see it.

```ts
type LoreGame = {
  id: number;
  group_id: number;
  message_id: number;
  lore_id: number;            // "Open Lore" after the reveal → /lore/{lore_id}
  started_by: string | null;
  prompt: string;             // the moment's title with names masked, ≤ 60 chars
  question: string;           // "Who was it?"
  hints: string[];            // the unlocked ones, vague → specific (all of them once revealed)
  hints_total: number;        // 3
  options: {
    user: User;
    votes: number;            // counts are always shown
    voters: User[];           // who picked it: empty until revealed
  }[];
  my_vote: string | null;     // the viewer's pick (user id)
  total_votes: number;
  member_count: number;       // "3 of 4 voted"
  can_reveal: boolean;        // the viewer may tap Reveal now
  status: "open" | "revealed";
  answer: User | null;        // revealed only
  lore_title: string | null;  // revealed only
  created_at: string;
  revealed_at: string | null;
};
```

Server design (not part of the contract): Muse gets the moment's title, story, a few of its
messages and the member list (with `about`) and returns a masked prompt, the subject and 3 hints.
A prompt that still contains a member's name or username, or one of the group's nickname/person
glossary terms, is retried once, then the title is masked deterministically (each name becomes
"Someone") with plain hints (when it happened, what it holds, the first letter of the name).
Hints that name names are replaced the same way. Options are the subject plus up to 3 other
members, shuffled with the game id as seed.

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

Defined in `backend/app/models.py`, created on startup with `CREATE EXTENSION vector`. Columns added later are
added in place (`UPGRADES` in `backend/app/core/db.py`), and lore without `events` gets them
computed then, once.

| Table | Key fields |
| --- | --- |
| `users` | `id (slug), username, display_name, avatar_url, phonetic_hint, pronunciation_audio_url, about` |
| `groups` | `id, name, avatar_url, is_dm, created_at` |
| `memberships` | `group_id, user_id, joined_at, last_read_message_id` |
| `messages` | `id, group_id, sender_id, kind, text, ts, reply_to, image_path, image_width, image_height, image_description, tsv (generated over text + image_description, GIN)` |
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
| `lore` | `id, group_id, title, story (not served), status, source, call_id, started_at, ended_at, people text[], terms text[], message_ids bigint[], replay_ids int[], anchor_message_id, events jsonb, hero_message_id, score, embedding vector, kept_by, kept_at, created_at` |
| `lore_pins` | `user_id, lore_id, pinned_at` (primary key `user_id, lore_id`) |
| `lore_replays` | `id, call_id, group_id, audio_path, duration_ms, started_at, captions jsonb, signal, created_at` |
| `lore_games` | `id, group_id, lore_id, message_id (unique: the game message), started_by, prompt, question, hints jsonb, hints_shown, options jsonb (user ids), answer_id, status (open/revealed), created_at, revealed_at` |
| `lore_game_votes` | `game_id, user_id, choice, voted_at` (primary key `game_id, user_id`) |
