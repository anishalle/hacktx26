# Seed fixtures

```sh
uv run python -m app.seed                # drop + recreate all tables, load fixtures/*.json, embed windows, backfill digests
uv run python -m app.seed --no-digests   # skip the (LLM-backed) digest backfill
uv run python -m app.seed --no-embeddings  # skip embedding message windows (Bedrock)
uv run python -m app.seed path/a.json    # load only these files
uv run python -m app.seed --no-anchor    # end every story at load time (see "anchor" below)
uv run python -m app.seed --media-only   # only copy seed photos into MEDIA_DIR (no DB changes)
```

`--media-only` is for a second server that shares the database (e.g. a homelab box): the
photos live in each server's `MEDIA_DIR`, under names derived from their bytes (sha256 hex
+ `.jpg`), so copying them there makes the seeded `image_path`s resolve without reseeding.

Every `fixtures/*.json` file is loaded in name order into one fresh database. Times are
relative: every `*offset_s` is **seconds before load time**, so "Priya joined 2 days ago" stays
true whenever you seed. Message ids are assigned by the database; fixtures refer to messages by
`idx`, which the loader maps to real ids.

## Format

```jsonc
{
  "anchor": { "local": "2026-10-25T12:00:00", "tz": "America/Chicago" },  // optional
  "users": [
    {
      "id": "priya",                     // slug, primary key
      "username": "priya.k",
      "display_name": "Priya Kapoor",
      "avatar_url": null,                // optional
      "phonetic_hint": "PREE-yah",       // optional
      "pronunciation_audio_url": null,   // optional
      "about": "Dad. 52, engineer. ..."  // optional: who they are; explanations are written for it
    }
  ],
  "groups": [
    {
      "key": "volleyball",               // unique across ALL fixture files; tests use it
      "name": "Thursday Volleyball",     // DMs: anything ("" is fine), the API names them per viewer
      "avatar_url": null,                // optional
      "is_dm": false,                    // optional, default false
      "created_offset_s": 3456000,       // optional, default: oldest join/message offset
      "members": [
        {
          "user_id": "priya",
          "joined_offset_s": 172800,     // joined 2 days ago
          "last_read_idx": null          // idx of last read message; null = never read
        }
      ],
      "messages": [
        {
          "idx": 0,                      // unique within the group
          "sender_id": "aakash",         // null for kind "system"
          "kind": "text",                // "text" (default) | "system" | "photo" | "game"
          "text": "ok from now on swayam's house = Grandma",
          "offset_s": 3110400,
          "reply_to_idx": null,          // optional, idx in the same group
          "reactions": [{ "user_id": "maya", "emoji": "😂" }]  // optional
        },
        {
          "idx": 40,
          "sender_id": "maya",
          "kind": "photo",
          "image": "ramen.jpg",          // a file in app/seed/media
          "image_description": "A bowl of ramen ...",  // what Muse would have written
          "text": "worth the wait",      // optional caption, default ""
          "offset_s": 7200
        },
        {
          "idx": 41,
          "sender_id": "maya",           // who started it
          "kind": "game",                // a Guess that Lore round; text defaults to "Guess that Lore 🎲"
          "offset_s": 3600,
          "game": {
            "lore_title": "The Grandma Incident",  // a title from this group's "lore"
            "started_by": "maya",        // optional, default sender_id
            "prompt": "Someone's House Got a New Name",
            "question": "Who was it?",   // optional
            "hints": ["vague", "warmer", "specific"],
            "hints_shown": 1,            // optional, default 0
            "options": ["swayam", "maya", "aakash"],  // member ids
            "answer": "swayam",          // one of the options
            "status": "open",            // open (default) | revealed
            "votes": [{ "user_id": "aakash", "choice": "swayam", "offset_s": 3500 }],  // offset optional
            "revealed_offset_s": 1800    // optional, revealed games only (default: the message's time)
          }
        }
      ],
      "glossary": [
        {
          "term": "Grandma",
          "aliases": ["grandma's", "grandmas"],
          "meaning": "Swayam's house ...",
          "kind": "nickname",            // nickname | place | event | slang | person | inside_joke
          "confidence": 0.95,            // optional, default 1.0
          "source": "seed",              // optional: seed (default) | auto | human
          "first_seen_idx": 10,          // -> first_seen_ts
          "last_explained_idx": 13,      // optional -> last_explained_ts
          "source_idxs": [10, 12, 13]    // -> source_message_ids
        }
      ],
      "lore": [                          // optional: kept moments, so games and the demo
        {                                // don't depend on Muse finding them
          "title": "The Grandma Incident",
          "story": "Swayam's house became Grandma's ...",  // optional, default the title
          "message_idxs": [10, 12, 13],  // the evidence
          "hero_idx": 40,                // optional: the photo (or quote) shown first
          "people": ["swayam"],          // optional, default the senders
          "terms": ["Grandma"],          // optional
          "score": 0.8,                  // optional
          "kept_by": "maya",             // optional
          "kept_offset_s": 3000          // optional, default the last message's time
        }
      ],
      "lore_backfill_before_idx": 50     // optional: the seed's lore backfill (Muse) only
    }                                    // scans messages before this one
  ]
}
```

Rules:

- Messages are inserted oldest first (by `offset_s` descending, then `idx`), so ids follow time.
- Users may be repeated across files (the first definition wins); group keys may not.
- A newcomer for feature 2 is a member whose join is later than a term's
  `coalesce(last_explained, first_seen)`; give newcomers a small `joined_offset_s`.
- Unread for a member is everything after `last_read_idx`, or since joining when it's null.
- Photos are copied into `settings.MEDIA_DIR` (as for an upload: JPEG, at most 1600 px, no
  EXIF; files already like that are copied byte for byte) and get `image_path`, width and
  height. Only use the hand-picked photos in `app/seed/media`, each at most twice.
- Fixture `lore` is inserted as kept, with its events computed by the lore service like
  any kept moment; the seed embeds it before the lore backfill, which then merges Muse's
  matching moments into it. `lore_backfill_before_idx` keeps the newest messages out of
  that backfill, so a fresh moment can be saved by hand in the demo.
- Game messages need their lore in the same group; options and voters must be members,
  the answer an option. The loader rejects a fixture that breaks these.
- `anchor` (optional): the local time the story was written for. Text like "saturday" or
  "its 2am" only matches the timestamps if offsets count back from that weekday and clock
  time, so the loader counts back from the anchor's latest weekly occurrence before now
  (the data may be up to a week stale), or from now when loading at most 12h before the
  next occurrence. `demo.json` is anchored to Sunday noon: seed on the demo day after
  noon for a chat whose drama was "last night"; seeding Sunday morning drifts by a few hours.

## In tests

`backend/tests/conftest.py` exposes `load_fixture` (call it with a dict in this format),
`read_fixture(name)` (`backend/tests/fixtures/<name>`, else `fixtures/<name>`) and `sample`
(loads `backend/tests/fixtures/sample.json`). Both return a `LoadedFixture`:
`fx.group_id("volleyball")`, `fx.msg("volleyball", 13)` (db id of idx 13),
`fx.groups["volleyball"].glossary_ids["Grandma"]`.

## Files

- `demo.json`: the demo dataset, built by `backend/scripts/generate_seed.py` from
  `backend/scripts/seed_outline.json` and the committed transcripts in
  `backend/scripts/transcripts/` (don't hand-edit the fixture; fix a transcript or the
  outline and rerun). Story time is Sunday noon: 16 users; `volleyball` (~2,100 messages:
  ~780 over 5 months, `aakash added priya.k` Friday noon, ~1,300 after, mostly Saturday's
  playoff game and Saturday night's drama about Sunday 8pm at Grandma's), glossary rows for
  Grandma's, usual spot, the Incident, procs and Torchy's Tuesday pointing at their defining
  messages, "pull a Brayden" used but never explained (no row); six small inbox chats.
- `family.json` and `friends.json`: hand-written, fictional, also anchored to Sunday noon.
  A family (Dad, Mom, Grandpa, two kids, an aunt and uncle, each with an `about`) in a
  home chat, an extended-family group and a grandpa DM, where slang and memes lose the
  parents and Telugu loses the kids; and the older kid's college friend group. Both carry
  kept `lore` and Guess that Lore games (a revealed one followed by the group
  reminiscing; an open one to vote on). The friend chat's newest messages are a fresh
  moment after `lore_backfill_before_idx`, left for the demo's Save to Lore. Photos come
  from `app/seed/media`.
- Tests use the small hand-written `backend/tests/fixtures/sample.json` instead.
