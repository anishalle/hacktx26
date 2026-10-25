# HackTX Design Doc — Newcomer Group Chat Assistant

Oct 24, 2026 · @Anish Reddy Alle

## Overview

We are building a standalone group-chat app with an AI layer that helps a newcomer understand a group's inside context on demand, and nudges existing members to be clearer when a newcomer is present. The pitch example is an international student added to a dozen college group chats full of nicknames, inside jokes and events they weren't around for.

The product is dual-facing. The newcomer holds on any message (or taps a **?** button during a video call) and gets the most concise explanation of what was meant, pulled from the group's own history. The existing member who types a niche message gets a one-tap suggestion to rephrase it for the newcomer. Nothing happens without the user asking for it or approving it.

Built for HackTX, Oct 24–25, 2026. Working name: TBD (see Open questions). Source: [Granola notes, "hacktx take 100201"](https://notes.granola.ai/d/d132a310-8d17-4543-adb7-86683ba948f0), with the unrelated conversation from roughly minute 27 onward filtered out, except for a few product and planning decisions made in passing.

## Problem

Newcomers to an established group chat can't follow the conversation, because the group runs on context they never saw: nicknames ("Grandma" means a specific friend's house), inside jokes, slang, places everyone goes, and events that were settled hundreds of messages ago. The result is that the newcomer stays silent and never assimilates.

**Target user for the pitch:** international students arriving at college, who get added to many group chats at once and face both unfamiliar slang and unfamiliar names. We say "for example, an international student" and let judges generalize it.

**Who it generalizes to:** any newcomer to any group — a new hire added to a team channel, a new roommate, a relative added to a family chat who doesn't know Gen Z slang ("6-7", "rizz"). The family / cross-generation case is a secondary pitch angle: the same tool connects generations.

**What doesn't work today**

- Scrolling back through 1,000+ messages is not realistic.
- Asking the group "what does Grandma mean?" is socially costly for a newcomer.
- Pasting messages into ChatGPT loses the group's history; a general model doesn't know that "Grandma" is a house.
- Dumping all the group's insider context on the newcomer at once is useless: it's a vocab list, and nobody retains a vocab list. Context has to arrive when it's needed, in context.

**Two things we are not doing**

- Not integrating with iMessage. It is not possible to hook into iMessage; we build our own chat surface instead and seed it with real group-chat history.
- Not pushing explanations unprompted. We decided against auto-notifying a newcomer about every inside reference. The newcomer asks; the app answers.

## Scope

Five features ship in the demo; the first two are the core and must work end to end. Everything else is a bonus once the core is solid.

| # | Feature | Who it serves | Priority | Owning sub-team |
| --- | --- | --- | --- | --- |
| 1 | Hold-to-explain (**?**) on any chat message | Newcomer | P0 — core | Text |
| 2 | Pre-send clarity nudge with one-tap rephrase | Existing member | P0 — core | Text |
| 3 | On-demand catch-up on a 1,000+ message backlog | Newcomer | P1 | Text |
| 4 | Live **?** button in a group video call over a speech-to-text transcript | Newcomer | P1 | Video |
| 5 | Name pronunciation (audio clip on profile) | International students | P2 | Text (small) |

**In scope**

- Our own chat app: group chats, message list, composer, user profiles, a group video call screen.
- Seeded with a real group chat's exported history so the AI has real context to draw on.
- An AI service that does targeted retrieval over group history and returns short explanations.
- A fallback path when the AI can't find the answer: ask the member who knows.

**Out of scope**

- iMessage, Instagram or Messenger integration. We present the app as the surface this would live in if we had platform access (see Pitch positioning).
- Proactive, unprompted explanations to the newcomer.
- Full-history summarization on every open. Catch-up (feature 3) runs only when the user asks.
- Auth, accounts, push notifications, app-store packaging. Hardcoded demo users are fine.

## Feature 1 — Hold-to-explain (?) on a message

The newcomer long-presses any message and gets the shortest possible explanation of what it means, built from the group's own history. This is the core of the demo.

**Example.** Message: "Grandma's after the game." The newcomer holds on it. The app answers: *"Grandma" is the group's nickname for Swayam's house. The group usually goes there after football games.*

**User flow**

1. Long-press a message bubble (or tap the small **?** that appears on hover/press).
2. A sheet slides up with a loading state ("Figuring out what this means…").
3. The sheet shows the explanation: 1–3 sentences, with the term in bold, plus up to 3 "where this came from" snippets (older messages, with sender and date) the user can tap to jump to.
4. Optional follow-up box: "Ask something else about this" (free-text; same context).
5. Dismiss. Nothing is posted to the chat. The group never sees that the newcomer asked.

**Behavior rules**

- On-demand only. The sheet opens only on the user's action.
- Concise. Lead with the meaning, not with the history. If the user wants more, they ask.
- Scoped to the message. The AI explains the pressed message (and the term(s) in it), not the whole thread.
- Grounded. Every claim traces to messages in the group; the sheet shows the evidence snippets.
- Private. Explanations are only visible to the person who asked.
- Honest when it doesn't know. If the group history has no explanation of the term, the sheet says so and offers the fallback (see AI context pipeline): "Want me to ask \[sender\] what this means, without making it a thing?"

**What the AI gets as input**

- The pressed message, its sender, timestamp, and the 20 messages around it.
- Retrieval results for the candidate terms in the message (see AI context pipeline).
- The group's member list and the newcomer's join date (so it knows what was said before they arrived).

**Edge cases**

- Message has nothing unusual ("ok see you at 7"): the sheet says it reads as plain and offers the catch-up feature instead.
- Multiple unknown terms in one message: explain each in one line; bold each term.
- Term is a person's name: show the profile card and, if present, the pronunciation clip (feature 5).
- Term is a place or event: say what/where it is and when the group last went or last mentioned it.

## Feature 2 — Pre-send clarity nudge for existing members

When an existing member is about to send a message that leans on inside context, and a newcomer is in the group, the composer offers to rewrite it so the newcomer can follow. One tap accepts; the member stays in control of every word.

**Example.** Existing member types: "grandma's after the game, usual spot." A small banner appears above the composer: *Priya joined 2 days ago and might not know "Grandma" or "usual spot." Rewrite for her?* Tapping **Rewrite** replaces the draft with: "Heading to Swayam's house (we call it Grandma's) after the game, in the back lot like usual." The member can edit it, send it, or tap **Keep mine**.

**User flow**

1. Member types in the composer. On pause (\~800 ms after the last keystroke) or on tapping send, the draft is checked.
2. If the check flags the draft, a banner appears: who the newcomer is, which terms were flagged, and two buttons: **Rewrite** and **Keep mine**. Send is not blocked.
3. **Rewrite** swaps in the suggested text with the changed parts highlighted. The member can keep editing.
4. Send as normal. The message goes out as the member wrote or approved it; no annotation is attached.

**When the nudge fires**

- There is at least one member whose join date is after the last time a flagged term was explained or defined in the chat.
- The draft contains a term the group uses with a non-literal meaning (nickname, inside joke, place alias, recurring event), detected by the same retrieval index as feature 1.

**When it stays quiet**

- No newcomers in the group.
- The draft is plain language.
- The member dismissed the nudge for that term in this group before (remember per member × term × group; don't nag).

**The second case: the AI doesn't know the term either**

If the draft contains an inside joke the AI can't resolve from history, the nudge changes shape: *This looks like an inside reference and I can't find where it's explained. Priya probably doesn't know it. Add a quick aside?* This is the same fallback path that feature 1 triggers from the newcomer's side (see AI context pipeline): the person who knows gets asked, and the newcomer never has to be the one asking.

**Rules**

- Nothing is sent, edited or changed without the member tapping a button.
- The nudge is private to the sender; the group doesn't see it.
- Keep the member's voice: the rewrite adds a short parenthetical or an extra clause, it doesn't rewrite the whole message in a different tone.

## Feature 3 — Catch up on a 1,000+ message backlog

When the newcomer opens a chat with a wall of unread messages, they can ask what happened and get a short, situational summary instead of reading a thousand messages. It runs only when asked.

**Example.** The newcomer opens the chat to 1,200 unread messages about a drama from last night. They tap **Catch me up**. The sheet says: *Last night the group argued about whether to still go to Grandma's Saturday after Mike bailed. Decision: still going, 8pm. Two people are annoyed at Mike. Unanswered: who's driving.*

**User flow**

1. A pill appears at the top of the chat when unread count ≥ 50 (configurable): **Catch me up (1,200 unread)**.
2. Tap it. The sheet shows: what happened (3–6 bullets), decisions made, anything still open, and any terms it noticed the newcomer may not know (each tappable → feature 1 explanation).
3. Optional free-text follow-up ("what did they decide about Saturday?").
4. Dismiss; unread state is left alone unless the user marks as read.

**Rules**

- User-triggered only. No auto-summary on open.
- Situational, not encyclopedic: what matters now, not a vocab list of every inside term.
- Range-bounded: summarize from the last-read marker (or the join date) to now. If that span is above the token budget, summarize in chunks and merge (map-reduce), newest chunk weighted highest.
- Link back: every bullet carries a tap target to the message range it came from.

## Feature 4 — Live ? button in a group video call

During a group video call, a small **?** button sits on screen. Tap it whenever you didn't follow what was just said, and the app explains the last stretch of conversation using a running speech-to-text transcript. It is the Granola "Ask anything" mechanic applied to a FaceTime-style call.

**Example.** Four people on a call; someone says "bro you're getting procs." The newcomer taps **?**. A card appears only on their screen: *"Procs" here means getting hit with something repeatedly (the group uses it for someone getting roasted). They're saying you're getting roasted.*

**User flow**

1. Join a group call. Speech-to-text runs for the whole call; the transcript accumulates locally and on the server with speaker labels where available.
2. Tap **?** (bottom-right, always visible, no menu).
3. The app takes the last \~45 seconds of transcript (plus the last 2 minutes as background), runs the same explain pipeline as feature 1, and shows a card over the call UI, private to the tapper.
4. The card has a one-line meaning, who said it, and an optional free-text follow-up.
5. Card auto-dismisses after 15 seconds or on tap.

**Rules**

- On-demand only; the call is never interrupted and other participants don't see the card.
- Latency target: explanation on screen within \~3 seconds of the tap. Transcript must already be flowing; the tap must not trigger a fresh transcription.
- The explain pipeline gets both the live transcript window and the group's chat history, so a term defined in chat months ago is still explained on a call.
- If the audio was unclear, the card says what it heard ("I caught: '…getting procs…'") and asks whether to explain that.

**Implementation notes**

- Call surface: Amazon Chime SDK meetings through a small Expo native module (`frontend/modules/chime-call`, wrapping the Chime iOS SDK): audio, video tiles, mute and camera. The server creates the meeting and one attendee per member (Chime's `ExternalUserId` is our user id). Requires an Expo dev build (`npx expo run:ios`), not Expo Go.
- Speech-to-text: Chime live transcription (Amazon Transcribe) starts with the call; transcript events reach every participant. Each client forwards final results to the API, which stores them in `call_transcripts` (deduplicated by Chime's result id; a late partial never overwrites a final). Partials are on-screen captions only. The server never touches raw audio.
- The **?** handler is one backend call: `POST /calls/{id}/explain` with `{user_id, at_ms, pending_results}`; the server clips the transcript at `at_ms` by word timestamps (45 s focus, 2 min background), adds results not uploaded yet, and runs the feature 1 pipeline with the call as the subject, so chat history and the glossary apply. Follow-ups go through `POST /explain` like feature 1.
- Demo plan: two phones on one call, one person says a planted inside reference, the other taps **?**.

## Feature 5 — Name pronunciation and the cross-generation angle

**Name pronunciation.** Each user can record a 2–3 second clip of their own name on their profile, the way LinkedIn does. Anyone can tap the small speaker icon next to the name in the member list, on a profile, or in the feature-1 sheet when the pressed term is a person. International students are the obvious beneficiary; it also makes the app feel built for them rather than retrofitted.

- Record: profile → tap mic → record up to 3 s → preview → save. Stored as a small audio blob keyed by user id.
- Play: speaker icon next to the display name wherever it appears. One tap, no page change.
- Optional: a phonetic hint field ("swy-AM") shown under the name.

**Cross-generation / family chat.** The same explain mechanic works in a family group chat where a parent doesn't know what "6-7" or "rizz" means. For terms with no in-chat definition, the pipeline can fall back to a general slang source (the model's own knowledge, or a trending-slang feed) and say so: *Not defined in this chat; generally it means…* This is a one-line addition to the pipeline and a strong secondary story for the pitch. No separate UI.

## AI context pipeline

We never hand the model the whole chat. Each **?** is a targeted retrieval around the flagged term, a short grounded answer, and, when history has no answer, a private ask to the member who knows. This is what makes it more than semantic search: it resolves meaning, it knows what was said before the newcomer joined, and it closes the loop with a human when the data isn't there.

&#91;embedded content: explain pipeline · 4 steps, 1 decision, human fallback\]

The decision in the middle is the whole product: a confident, sourced answer when the chat holds the context, and an honest hand-off to a person when it doesn't.

**1. Import-time indexing (once per group)**

- Store every message as `{id, group_id, sender_id, ts, text, reply_to}`.
- Keyword index (BM25/Postgres full-text) over message text.
- Embedding index over windows of 10 consecutive messages (not single messages, so a definition and its usage land in the same chunk), embedded with Amazon Bedrock Titan Text Embeddings v2 (1024 dimensions) and searched with pgvector. New windows are embedded in the background as they fill; without AWS credentials retrieval runs on full text alone.
- **Auto-glossary pass:** one LLM sweep over the history in chunks that extracts recurring non-literal terms — nicknames, place aliases, event names, slang — with `{term, aliases, meaning, confidence, first_seen_ts, source_message_ids}`. This table is what feature 2 uses to detect inside references in a draft, and it is the first thing feature 1 checks.

**2. Query-time, per ? (feature 1 and feature 4)**

1. Extract candidate terms from the pressed message or transcript window: one small LLM call that returns terms that look non-literal, plus proper nouns. Fallback heuristic: capitalized words, quoted words, tokens absent from a common-English list.
2. For each term: glossary lookup → exact keyword hits → semantic hits. Take the top \~8 windows, preferring (a) glossary entries, (b) the earliest occurrences, (c) messages containing definitional language ("X means", "we call it", "aka"), (d) messages from before the newcomer's join date.
3. Generate with the LLM: inputs are the pressed message with its 20 neighbours, the glossary entries, the retrieved windows, any private answers members gave this newcomer, the member list and join date. Output is JSON: `{term, meaning, confidence (0–1), kind: nickname|place|event|slang|person|inside_joke|plain|unknown, general, source_message_ids, glossary_ids, ask_ids}`. Prompt rules: lead with the meaning, ≤ 3 sentences, cite only supplied evidence, return `confidence < 0.4` rather than guessing. The server drops citations outside the context; an uncited or low-confidence answer becomes the not-found fallback. Follow-ups reuse the stored context.
4. Budget: ≤ \~4k tokens of context per request so the answer comes back in \~2–3 s.

**3. Not-found fallback (feature 1 and the second case of feature 2)**

- Trigger: `confidence < 0.4` or no retrieval hits.
- Pick the person to ask: the message sender, else the member who uses the term most.
- Send them a private prompt: *Priya held on "Grandma" and I couldn't find where it's explained. Want to add a one-line explanation? Only she'll see it.* They can type an answer, or tap **Explain in chat** to post it publicly, or ignore it.
- Their answer is written to the glossary with `source: human` and shown to the newcomer. Next time, the pipeline finds it at step 2.
- Both ends are opt-in: the newcomer sees "Want me to ask?" before anything is sent; the member can decline.

**4. General-slang fallback (feature 5's family angle)**

If the term is absent from this group but is common slang, answer from general knowledge and label it: *Not defined in this chat; generally it means…* Never present general knowledge as if it came from the group.

**5. Catch-up (feature 3)** reuses the same stack: slice messages from last-read to now, chunk to \~3k tokens, summarize each chunk to decisions/open items/notable terms, merge, and link each bullet to its message range.

## System architecture

One React Native app (Expo) for iOS and Android, one API server, Postgres with pgvector (on Timescale Cloud) for history and embeddings, Meta's Muse for every language task, and Amazon Chime (with Amazon Transcribe live transcription) for calls. Everything is hackathon-simple: no auth, hardcoded demo users, one group chat seeded from a real export.

&#91;embedded content: system architecture · client, API, data and AI services\]

The three screens of the mobile app all talk to one API; the API is the only thing that talks to the database, the LLM, or Chime's control plane. The app runs on a real phone through Expo Go (or a dev build where native modules need it), which is also how we demo.

**Stack (proposed; swap freely if the team is faster in something else)**

| Layer | Choice | Why |
| --- | --- | --- |
| Client | React Native with Expo (TypeScript), Expo Router, NativeWind for styling | One codebase for iOS and Android; native long-press, haptics and bottom sheets make the hold-to-explain feel like iMessage |
| Gestures and sheets | `react-native-gesture-handler`, `@gorhom/bottom-sheet`, `expo-haptics` | Long-press on a bubble, slide-up explanation sheet, a haptic tick when it opens |
| Realtime messages | WebSocket (socket.io-client) | New messages fan out to all group members instantly |
| Calls | Amazon Chime SDK meetings (iOS SDK through a local Expo module) | Hosted rooms with 2–4 tiles and built-in live transcription; needs an Expo dev build, not Expo Go |
| Call audio to STT | Chime live transcription; clients forward final results to the API | No audio on our server and no STT keys on the device; one transcript store per call |
| Pronunciation audio | `expo-av` record and playback; upload to the API as m4a | Feature 5 with no extra native code |
| API | FastAPI (Python) | Same language as the import/indexing scripts and the LLM SDKs |
| Database | Postgres + pgvector, hosted on Timescale Cloud (local Docker Postgres for tests) | Messages, members, glossary and embeddings in one place; full-text search built in; one shared connection string with no cloud networking to set up |
| LLM | Meta Muse (`muse-spark-1.3`, minimal reasoning) through the OpenAI-compatible Meta Model API | Fast JSON-mode answers; one model for explain, rewrite, digests and catch-up |
| Embeddings | Amazon Bedrock Titan Text Embeddings v2 | Only used for the semantic leg of retrieval; the Meta Model API has no embedding model |
| STT | Amazon Transcribe through Chime live transcription | Partials and finals with word timings and per-attendee speaker labels |

**React Native notes**

- Start in Expo Go for the chat screens; switch to an Expo dev build (`npx expo run:ios`) only when the call SDK goes in, since WebRTC needs native modules.
- The explanation sheet is a bottom sheet over the chat, not a new screen, so the message stays visible behind it.
- The composer nudge is a banner above the input inside `KeyboardAvoidingView`, so it stays visible while typing.
- Keep all API calls in one `api.ts` client with the endpoint contract below so the text and video tracks share it.
- Demo on two physical phones on the same Wi-Fi, API tunneled with ngrok; have the iOS Simulator as a backup for screen recording.

**Data model**

| Table | Key fields |
| --- | --- |
| `users` | `id, display_name, avatar_url, pronunciation_audio_url, phonetic_hint` |
| `groups` | `id, name, created_at` |
| `memberships` | `group_id, user_id, joined_at` — `joined_at` is what makes someone a newcomer |
| `messages` | `id, group_id, sender_id, ts, text, reply_to, tsv (full-text)` |
| `message_windows` | `id, group_id, start_msg_id, end_msg_id, embedding (vector)` |
| `glossary` | \`id, group\_id, term, aliases\[\], meaning, kind, confidence, source (auto |
| `explanations` | \`id, group\_id, user\_id, message\_id |
| `member_asks` | \`id, group\_id, asked\_user\_id, for\_user\_id, term, status (pending |
| `nudge_dismissals` | `user_id, group_id, term` |
| `call_transcripts` | `call_id, result_id, speaker_id, start_ms, end_ms, text, items, is_partial` |

**API endpoints**

| Endpoint | Does |
| --- | --- |
| `GET /groups/{id}/messages?before=&limit=` | Paged history |
| `POST /groups/{id}/messages` | Send; fans out over WebSocket |
| `POST /explain` `{group_id, user_id, message_id? \| term?, explanation_id?, follow_up?}` | Feature 1; returns one grounded explanation with sources (see `docs/API.md`) |
| `POST /groups/{id}/call` `{user_id}` / `POST /calls/{id}/leave` | Feature 4; start or join the group's Chime call / leave it |
| `POST /calls/{id}/transcripts` `{user_id, results[]}` | Feature 4; store final transcript results |
| `POST /calls/{id}/explain` `{user_id, at_ms, pending_results?}` | Feature 4; clips the transcript server-side, explains with chat history |
| `POST /nudge/check` `{group_id, user_id, draft}` | Feature 2; returns `{flagged_terms[], newcomers[], unknown_terms[]}` |
| `POST /nudge/rewrite` `{group_id, user_id, draft, flagged_terms[]}` | Feature 2; returns the rewritten draft with diff spans |
| `POST /catchup` `{group_id, user_id, since_message_id}` | Feature 3 |
| `POST /ask-member` `{group_id, user_id, term, message_id?}` | Fallback; creates a `member_asks` row and pings the member |
| `POST /ask-member/{id}/answer` `{user_id, answer?, decline?, post_in_chat?}` | Member replies, posts it in chat, or passes; writes glossary, notifies the newcomer |
| `GET /users/{id}/asks` | The member's incoming and outgoing asks (the Requests sheet) |
| `PUT /users/{id}/pronunciation` | Feature 5 audio upload |

**Realtime events (WebSocket)**: `message.new`, `ask.new` (to the asked member), `ask.updated` (to both people on the ask), `call.updated` (to the group when a call starts, changes or ends).

## Demo data

The demo group chat is seeded from a real group chat export, so every explanation the judges see is grounded in real history. iMessage can't be exported in a usable way, so the source is Messenger / Facebook (Download Your Information → Messages → JSON).

**Import pipeline (`scripts/import_messenger.py`)**

1. Read `message_1.json` … `message_N.json` for the chosen thread; Messenger splits long threads across files, newest first.
2. Normalize: `sender_name → user_id`, `timestamp_ms → ts`, `content → text`; drop reactions, stickers and empty media-only messages; fix Messenger's mojibake (decode `content.encode('latin1').decode('utf8')`).
3. Insert into `messages`; build the full-text column.
4. Window into chunks of 10 messages → embed (Bedrock Titan v2) → `message_windows`.
5. Run the glossary sweep (\~3k-token chunks) → `glossary`. Review the output once by hand before the demo and fix anything wrong; a human-corrected glossary row is marked `source: human`.
6. Create the demo users and memberships. Set one user's `joined_at` to "today" so they are the newcomer.

**Demo script data to plant**

- Confirm the exported chat actually contains a few strong inside references with a traceable origin (a nickname for a place, a recurring event, a slang term). Write them down with their source messages: these are the three we show.
- Add 10–20 synthetic recent messages at the end of the import so the newcomer opens the chat to a live-looking thread that uses those terms.
- Add one term that is deliberately **not** explained anywhere in the history, to demo the ask-the-member fallback live.
- Record pronunciation clips for the demo users.

**Privacy.** Use a chat whose members have agreed; strip phone numbers and last names in the import; don't commit the export to the repo (`.gitignore` the `data/` folder, keep a 50-message sanitized sample for CI).

## Pitch positioning

The pitch leads with the international student, shows the three features in 90 seconds, and answers the two questions we already know judges will ask: "why isn't this just search?" and "why isn't this inside Instagram/Messenger?"

**Judge feedback already received (Mac, Oct 24).** He liked the idea but pushed on the AI part: it needs to be clearly more than semantic search, and the output needs to be something the newcomer actually understands. The 1,000+ message catch-up and the hold-to-explain both count as AI, but we have to show it, not say it.

**Our answer to "why not just search?"**

- Search returns messages; we return the meaning, in one line, with the messages as evidence.
- We know *when* the newcomer joined and prioritize what was said before they arrived.
- We cross-reference: a nickname defined in January and used in October is resolved across that gap.
- When the history can't answer, we route to a human privately. Search can't do that.
- Existing members get nudged before they send. That's a second model (detection + rewrite), not retrieval.

**Our answer to "why not inside Instagram / Messenger / iMessage?"**

- iMessage has no integration path. Messenger and Instagram DMs don't expose message-level hooks to third parties.
- So we built the chat surface ourselves and seeded it with a **real** group chat's history to prove it works on real data. We say exactly that.
- Positioning line: this is what the feature would look like inside Instagram DMs or Messenger; we only built the surface because we don't have platform access.
- If asked about standalone features: name pronunciation and the video-call **?** are things that make sense in a dedicated app anyway.

**Scope framing.** Say "for example, an international student" once, then let the family-chat / Gen Z slang example show it generalizes. Don't claim it handles every inside joke: say the limitation out loud (some things aren't in the chat) and show the fallback. Owning the limitation is the strongest moment of the demo.

**90-second demo order**

1. Newcomer opens the chat, sees "Grandma's after the game", holds → explanation with sources. (10 s)
2. Existing member types a niche message → nudge → one-tap rewrite → send. (15 s)
3. Newcomer holds on the planted unknown term → "not in the chat, want me to ask?" → member gets the private ask → answers → newcomer sees it. (25 s)
4. Group call: someone says the slang, newcomer taps **?**, card appears. (20 s)
5. Catch-me-up on 1,200 unread. (10 s)
6. Tap the speaker icon on a name. (5 s)

## Team split and build plan

Two people on text, two on video, one shared API and database. The text track is the core and must be demoable first; video plugs into the same explain endpoint once it exists.

| Track | People | Owns |
| --- | --- | --- |
| Text | 2 (names to confirm) | Chat UI, hold-to-explain sheet, composer nudge + rewrite, catch-up, name pronunciation, import script, glossary pass |
| Video | Anish + Sunny (per end of meeting; confirm) | Call screen (WebRTC room), streaming STT, transcript store, `/explain/call`, the **?** card |
| Shared | both tracks | Repo + plan.md, FastAPI skeleton, Postgres schema, `POST /explain/*` core, demo data, pitch + video |

**Setup (first 30 minutes)**

- [ ] Create the GitHub repo; add everyone (handles collected at the meeting).
- [ ] Export this doc to Markdown as `plan.md` in the repo root and feed it to Claude Code as the spec.
- [ ] Scaffold: `mobile/` (Expo React Native, TypeScript), `api/` (FastAPI), `scripts/`, `data/` (gitignored), `docker-compose.yml` with Postgres + pgvector.
- [ ] Agree on the API contract above so both tracks can build against it before it exists (stub responses are fine).
- [ ] Get API keys into `.env`: Meta Model API, AWS (embeddings), STT, WebRTC room service.

**Build order (text track)**

1. Schema + import script on the real Messenger export; confirm the three planted terms are in the data.
2. Chat screen with paged history and live send over WebSocket.
3. `POST /explain` end to end: extract → retrieve → LLM → JSON. Verify on the three planted terms before touching UI polish.
4. Hold-to-explain sheet with sources and follow-up.
5. Glossary sweep + `POST /nudge/check` + `/nudge/rewrite`; composer banner.
6. Ask-the-member fallback (`member_asks` + WebSocket ping + answer flow).
7. Catch-up pill + `POST /catchup`.
8. Name pronunciation (record/play).

**Build order (video track)**

1. WebRTC room with 2–4 tiles using the hosted service; join by link.
2. Stream mic audio to STT; write utterances to `call_transcripts` with speaker ids; show partials in a debug panel.
3. `POST /explain/call`: slice the last 45 s, reuse the text track's explain function (import it, don't rewrite it).
4. The **?** button and private card over the call UI.
5. Rehearse the two-phone demo until it's reliable; record a fallback video in case the venue Wi-Fi fails.

**Checkpoints**

| Checkpoint | Done when |
| --- | --- |
| C1 | Real export imported; `/explain/message` answers the three planted terms correctly from the command line |
| C2 | Hold-to-explain works in the UI; nudge banner fires on a planted draft |
| C3 | Call transcript is flowing; **?** returns an answer within 3 s |
| C4 | Fallback ask works end to end on the planted unknown term |
| C5 | Full 90-second demo runs twice in a row with no intervention; demo video recorded |

Anything after C5 (catch-up polish, pronunciation, UI theming) is bonus. If C3 is not reached by the halfway point, the video track joins text and the call demo becomes a mocked transcript.

## Demo video

Two short skits, split-screen where it helps, then the real product. Keep it under 2 minutes; the product shots must be real screen recordings, not mockups.

**Cold open (10 s).** An international student lands (airport shot or a bedroom "just arrived" shot), phone buzzes: added to six group chats. Scroll of unread counts.

**Skit 1 — the message (25 s).** Newcomer in bed, phone lights up: "grandma's after the game." Confused face. Split screen: on the left the newcomer holds on the message; on the right the existing member who typed it, oblivious. Explanation sheet slides up: *"Grandma" is Swayam's house…* Newcomer replies "omw" like they've been there for years.

**Skit 2 — the call (25 s).** Group FaceTime-style call, four tiles. Someone drops slang; newcomer is lost; taps **?**; private card pops. They laugh at the right moment. Nobody else on the call notices.

**Product walk (40 s).** Screen recording in the order of the 90-second demo: hold-to-explain, nudge + rewrite, the not-found ask, catch-me-up, pronunciation.

**Close (10 s).** One line on the problem, one on the generalization (new job, family chat, any group), the name, the team.

**Production notes**

- Record product shots last, after C5, so they match the final UI.
- Caption everything; judges often watch muted.
- Keep a raw copy of the recordings in case the edit needs to change after judge feedback.

## Open questions and risks

**Open questions**

- [ ] Product name. Nothing was chosen in the meeting.
- [ ] Which real group chat to export, and whether everyone in it is fine with it being used on stage.
- [ ] Final team assignment to tracks (video: Anish + Sunny was said at the end; text: the other two).
- [ ] Submission deadline and demo slot time, so the checkpoints get real times.
- [ ] Hosted WebRTC service and STT vendor: whichever someone on the team has used before wins.
- [ ] Do we show the family / Gen Z slang angle as a second demo group chat, or just mention it?

**Risks and mitigations**

| Risk | Mitigation |
| --- | --- |
| The real export has no clean inside references | Check the data first (C1); if thin, plant 30–50 synthetic historical messages that define the terms, and say so |
| Explanations are vague or hallucinated | Confidence threshold + mandatory source messages; if sources are empty, show the fallback instead of an answer |
| Judges see it as semantic search | Demo the join-date awareness, the cross-gap resolution, and the human fallback live; say the limitation out loud |
| STT latency or venue Wi-Fi breaks the call demo | Pre-recorded fallback video; mocked transcript mode behind a flag |
| Nudge fires too often and annoys the sender | Only fire when a newcomer exists; per-term dismissal memory; never block send |
| Token cost / latency on long histories | Retrieval capped at \~8 windows and \~4k tokens; catch-up is chunked and only on demand |
| Privacy of the real chat | Strip last names and numbers at import; never commit the export; use a sanitized sample in the repo |
| Scope creep from feature 3 and 5 | Both are after C5; cut without discussion if time is short |
