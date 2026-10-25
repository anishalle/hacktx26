# Seed fixtures

```sh
uv run python -m app.seed                # drop + recreate all tables, load fixtures/*.json, backfill digests
uv run python -m app.seed --no-digests   # skip the (LLM-backed) digest backfill
uv run python -m app.seed path/a.json    # load only these files
uv run python -m app.seed --no-anchor    # end every story at load time (see "anchor" below)
```

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
      "pronunciation_audio_url": null    // optional
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
          "kind": "text",                // "text" (default) | "system"
          "text": "ok from now on swayam's house = Grandma",
          "offset_s": 3110400,
          "reply_to_idx": null,          // optional, idx in the same group
          "reactions": [{ "user_id": "maya", "emoji": "😂" }]  // optional
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
      ]
    }
  ]
}
```

Rules:

- Messages are inserted oldest first (by `offset_s` descending, then `idx`), so ids follow time.
- Users may be repeated across files (the first definition wins); group keys may not.
- A newcomer for feature 2 is a member whose join is later than a term's
  `coalesce(last_explained, first_seen)`; give newcomers a small `joined_offset_s`.
- Unread for a member is everything after `last_read_idx`, or since joining when it's null.
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
- Tests use the small hand-written `backend/tests/fixtures/sample.json` instead.
