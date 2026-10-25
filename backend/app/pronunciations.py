"""Small, persistent demo-user audio store; no external database required."""

import sqlite3
from contextlib import contextmanager
from uuid import uuid4

from app.core.config import settings

DEMO_USERS = {"priya": "Priya", "swayam": "Swayam", "alex": "Alex"}
MAX_AUDIO_BYTES = 256 * 1024


@contextmanager
def connection():
    settings.PRONUNCIATION_DB.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(settings.PRONUNCIATION_DB) as db:
        db.row_factory = sqlite3.Row
        db.execute("""CREATE TABLE IF NOT EXISTS pronunciations (
            user_id TEXT PRIMARY KEY, audio BLOB NOT NULL,
            content_type TEXT NOT NULL, revision TEXT NOT NULL)""")
        yield db


def get_clip(user_id: str):
    with connection() as db:
        return db.execute(
            "SELECT * FROM pronunciations WHERE user_id = ?", (user_id,)
        ).fetchone()


def save_clip(user_id: str, audio: bytes, content_type: str) -> None:
    with connection() as db:
        db.execute(
            "INSERT OR REPLACE INTO pronunciations VALUES (?, ?, ?, ?)",
            (user_id, audio, content_type, uuid4().hex),
        )


def delete_clip(user_id: str) -> None:
    with connection() as db:
        db.execute("DELETE FROM pronunciations WHERE user_id = ?", (user_id,))
