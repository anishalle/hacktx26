# TODO

- [ ] **Cache catch-up results.** Every `POST /catchup` currently runs the reduce LLM call
  again, even when nothing new has arrived since the last one.
  - Key the cache on `(group_id, since_message_id, until_message_id)`. It stays valid until a
    new message lands, because `until` changes then.
  - On a cache hit, replay the stored bullets and terms over SSE, so the client code doesn't
    change.
  - Store it in Postgres (a `catchup_cache` table) or in memory. Backend code lives in
    `backend/app/services/catchup.py`.
- [ ] **Hold a message to explain it directly.** Right now a long-press opens the context
  menu and you have to tap **Explain**. Holding a message should open the explain sheet
  straight away (DESIGN.md feature 1: "Long-press a message bubble").
  - Decide where reactions, Reply and Copy go once a hold means explain.
  - The menu is `frontend/src/components/thread/MessageMenu.tsx`; the explain entry point is
    `useExplain` in `frontend/src/features/explain.ts`.
