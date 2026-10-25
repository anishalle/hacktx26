"""Parameterized PostgreSQL operations shared by HTTP and the indexing command."""

import json
import re
from uuid import uuid4

from fastapi import HTTPException

from app.core.config import settings

MESSAGE_SELECT = """
SELECT m.id, m.group_id, m.sender_id, u.name AS sender_name, m.ts, m.text
FROM messages m JOIN users u ON u.id = m.sender_id
"""

ASK_SELECT = """
SELECT a.*, m.group_id, m.text AS message_text,
       requester.name AS requester_name, recipient.name AS recipient_name
FROM member_asks a
JOIN messages m ON m.id = a.message_id
JOIN users requester ON requester.id = a.requester_id
JOIN users recipient ON recipient.id = a.recipient_id
"""


def require_membership(db, group_id: str, user_id: str):
    row = db.execute(
        """SELECT joined_at FROM memberships
        WHERE group_id = %s AND user_id = %s""",
        (group_id, user_id),
    ).fetchone()
    if row is None:
        raise HTTPException(403, "You are not a member of this group.")
    return row


def message(db, group_id: str, message_id: str):
    row = db.execute(
        MESSAGE_SELECT + " WHERE m.group_id = %s AND m.id = %s",
        (group_id, message_id),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "Message not found.")
    return row


def members(db, group_id: str):
    return db.execute(
        """SELECT u.id, u.name, m.joined_at FROM memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.group_id = %s ORDER BY u.name""",
        (group_id,),
    ).fetchall()


def page(db, group_id: str, limit: int, before: str | None, around: str | None):
    if around:
        anchor = message(db, group_id, around)
        rows = window(db, anchor, radius=50)
        return {"messages": rows, "has_more": False}
    params: list = [group_id]
    condition = " WHERE m.group_id = %s"
    if before:
        anchor = message(db, group_id, before)
        condition += " AND (m.ts, m.id) < (CAST(%s AS timestamptz), %s)"
        params.extend([anchor["ts"], anchor["id"]])
    params.append(limit + 1)
    rows = db.execute(
        MESSAGE_SELECT + condition + " ORDER BY m.ts DESC, m.id DESC LIMIT %s",
        params,
    ).fetchall()
    return {"messages": list(reversed(rows[:limit])), "has_more": len(rows) > limit}


def window(db, anchor: dict, radius: int = 100) -> list[dict]:
    """Exactly radius predecessors and successors within this group; stable on ties."""
    params = (anchor["group_id"], anchor["ts"], anchor["id"], radius)
    before = db.execute(
        MESSAGE_SELECT
        + """ WHERE m.group_id = %s
        AND (m.ts, m.id) < (CAST(%s AS timestamptz), %s)
        ORDER BY m.ts DESC, m.id DESC LIMIT %s""",
        params,
    ).fetchall()
    after = db.execute(
        MESSAGE_SELECT
        + """ WHERE m.group_id = %s
        AND (m.ts, m.id) > (CAST(%s AS timestamptz), %s)
        ORDER BY m.ts, m.id LIMIT %s""",
        params,
    ).fetchall()
    return [*reversed(before), anchor, *after]


def vector_literal(vector: list[float]) -> str:
    return "[" + ",".join(str(float(value)) for value in vector) + "]"


def search(db, selected: dict, vector: list[float]) -> list[dict]:
    # OR permits finding an old definition when the selected sentence has extra words.
    words = re.findall(r"[a-zA-Z0-9]+", selected["text"])
    query = " OR ".join(dict.fromkeys(words[:80]))
    keyword = db.execute(
        """SELECT id FROM messages
        WHERE group_id = %s AND id <> %s
          AND search @@ websearch_to_tsquery('english', %s)
        ORDER BY ts_rank_cd(search, websearch_to_tsquery('english', %s)) DESC,
                 ts, id LIMIT 12""",
        (selected["group_id"], selected["id"], query, query),
    ).fetchall()
    semantic = db.execute(
        """SELECT id FROM messages
        WHERE group_id = %s AND id <> %s
          AND embedding_model = %s AND embedding IS NOT NULL
        ORDER BY embedding <=> CAST(%s AS vector) LIMIT 12""",
        (
            selected["group_id"],
            selected["id"],
            settings.BEDROCK_EMBEDDING_MODEL_ID,
            vector_literal(vector),
        ),
    ).fetchall()
    # Reciprocal rank fusion combines keyword and vector evidence without mixing scales.
    scores: dict[str, float] = {}
    for ranking in (keyword, semantic):
        for rank, item in enumerate(ranking):
            scores[item["id"]] = scores.get(item["id"], 0) + 1 / (60 + rank + 1)
    ids = sorted(scores, key=lambda key: (-scores[key], key))
    return [
        message(db, selected["group_id"], key) for key in ids[: settings.RETRIEVAL_HITS]
    ]


def merge_windows(windows: list[list[dict]]) -> list[dict]:
    unique = {row["id"]: row for rows in windows for row in rows}
    return sorted(unique.values(), key=lambda row: (row["ts"], row["id"]))


def build_context(db, selected: dict, hits: list[dict]) -> list[dict]:
    # Keep each hit's 201-message window intact. Reduce hit count, never crop a window.
    windows = [window(db, selected)]
    if len(json.dumps(windows, default=str)) > settings.CONTEXT_MAX_CHARS:
        raise HTTPException(413, "This context window is too large to explain.")
    for hit in hits:
        hit_window = window(db, hit)
        candidate = merge_windows([*windows, hit_window])
        if len(json.dumps(candidate, default=str)) <= settings.CONTEXT_MAX_CHARS:
            windows.append(hit_window)
    return merge_windows(windows)


def private_answers(db, group_id: str, message_id: str, user_id: str):
    selected = message(db, group_id, message_id)
    words = re.findall(r"[a-zA-Z0-9]+", selected["text"])
    query = " OR ".join(dict.fromkeys(words[:80]))
    return db.execute(
        ASK_SELECT
        + """ WHERE m.group_id = %s
        AND a.requester_id = %s AND a.status = 'answered'
        AND (a.message_id = %s OR a.search @@ websearch_to_tsquery('english', %s))
        ORDER BY (a.message_id = %s) DESC, a.answered_at DESC, a.id LIMIT 12""",
        (group_id, user_id, message_id, query, message_id),
    ).fetchall()


def list_asks(db, group_id: str, user_id: str):
    return db.execute(
        ASK_SELECT
        + """ WHERE m.group_id = %s
        AND (a.requester_id = %s OR a.recipient_id = %s)
        ORDER BY a.created_at DESC, a.id LIMIT 100""",
        (group_id, user_id, user_id),
    ).fetchall()


def create_ask(db, group_id: str, message_id: str, requester: str, question: str):
    selected = message(db, group_id, message_id)
    if selected["sender_id"] == requester:
        raise HTTPException(400, "You cannot ask yourself for an explanation.")
    ask_id = str(uuid4())
    row = db.execute(
        """INSERT INTO member_asks
        (id, message_id, requester_id, recipient_id, question)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (message_id, requester_id, question)
        DO UPDATE SET question = EXCLUDED.question""",
        (ask_id, message_id, requester, selected["sender_id"], question),
    )
    row = db.execute(
        """SELECT id FROM member_asks
        WHERE message_id = %s AND requester_id = %s AND question = %s""",
        (message_id, requester, question),
    ).fetchone()
    return db.execute(ASK_SELECT + " WHERE a.id = %s", (row["id"],)).fetchone()


def answer_ask(db, ask_id: str, user_id: str, answer: str | None, decline: bool):
    # The participant check precedes any disclosure of the private request.
    ask = db.execute(
        ASK_SELECT + " WHERE a.id = %s AND a.recipient_id = %s",
        (ask_id, user_id),
    ).fetchone()
    if ask is None:
        raise HTTPException(404, "Private request not found.")
    require_membership(db, ask["group_id"], user_id)
    if not decline and not answer:
        raise HTTPException(422, "Write an answer or decline the request.")
    updated = db.execute(
        """UPDATE member_asks SET answer = %s, status = %s, answered_at = now()
        WHERE id = %s AND recipient_id = %s AND status = 'pending'""",
        (
            None if decline else answer,
            "declined" if decline else "answered",
            ask_id,
            user_id,
        ),
    )
    if not updated.rowcount:
        raise HTTPException(409, "This request has already been resolved.")
    return db.execute(ASK_SELECT + " WHERE a.id = %s", (ask_id,)).fetchone()
