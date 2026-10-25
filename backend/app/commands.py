"""Run with python -m app.commands seed|index [--watch]."""

import argparse
import time

from app import bedrock
from app.core.config import settings
from app.core.db import connect
from app.demo import GROUP_ID, USERS, demo_messages
from app.repository import vector_literal


def seed():
    rows = demo_messages()
    with connect() as db:
        for user_id, name in USERS:
            db.execute(
                "INSERT INTO users (id, name) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (user_id, name),
            )
        db.execute(
            "INSERT INTO groups VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (GROUP_ID, "The Longhorns"),
        )
        for user_id, _ in USERS:
            joined = rows[-1]["ts"] if user_id == "priya" else rows[0]["ts"]
            db.execute(
                """INSERT INTO memberships VALUES (%s, %s, CAST(%s AS timestamptz))
                ON CONFLICT DO NOTHING""",
                (GROUP_ID, user_id, joined),
            )
        with db.cursor() as cursor:
            cursor.executemany(
                """INSERT INTO messages (id, group_id, sender_id, ts, text)
                VALUES (%(id)s, %(group_id)s, %(sender_id)s,
                        CAST(%(ts)s AS timestamptz), %(text)s)
                ON CONFLICT DO NOTHING""",
                rows,
            )
    print("Synthetic group ready: longhorns; demo users: priya, swayam, alex.")


def index_pending(limit: int) -> int:
    completed = 0
    for _ in range(limit):
        # Each embedding commits independently, so interrupted imports can resume.
        with connect() as db:
            row = db.execute(
                """SELECT id, text FROM messages
                WHERE embedding IS NULL OR embedding_model IS DISTINCT FROM %s
                ORDER BY ts, id FOR UPDATE SKIP LOCKED LIMIT 1""",
                (settings.BEDROCK_EMBEDDING_MODEL_ID,),
            ).fetchone()
            if row is None:
                break
            vector = bedrock.embed(row["text"])
            db.execute(
                """UPDATE messages SET embedding = CAST(%s AS vector),
                    embedding_model = %s
                WHERE id = %s""",
                (
                    vector_literal(vector),
                    settings.BEDROCK_EMBEDDING_MODEL_ID,
                    row["id"],
                ),
            )
            completed += 1
    return completed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["migrate", "seed", "index"])
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--watch", action="store_true")
    args = parser.parse_args()
    if args.command == "migrate":
        from app.schema import upgrade

        print(f"Database schema ready: {upgrade()}.")
        return
    if args.command == "seed":
        seed()
        return
    while True:
        count = index_pending(args.limit)
        print(f"Indexed {count} messages.", flush=True)
        if not args.watch:
            break
        time.sleep(3)


if __name__ == "__main__":
    main()
