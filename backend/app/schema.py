"""Idempotent application schema migrations shared by Alembic and RDS Data API."""

from app.core.config import settings
from app.core.db import connect
from app.migrations import revisions


def upgrade():
    with connect() as db:
        db.execute("CREATE EXTENSION IF NOT EXISTS vector")
        db.execute(
            """CREATE TABLE IF NOT EXISTS chat_schema_migrations (
                version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
            )"""
        )
        current = db.execute(
            "SELECT version FROM chat_schema_migrations ORDER BY version DESC LIMIT 1"
        ).fetchone()
        version = (
            current["version"]
            if isinstance(current, dict) and current
            else (current[0] if current else None)
        )
        for name, statements in revisions():
            if name <= (version or ""):
                continue
            for statement in statements:
                db.execute(statement)
            db.execute(
                """INSERT INTO chat_schema_migrations (version)
                VALUES (%s) ON CONFLICT DO NOTHING""",
                (name,),
            )
    return settings.DATABASE_NAME
