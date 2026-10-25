from contextlib import contextmanager

# Reuse the PostgreSQL fixtures so storage is tested against a real vector column.
from test_chat_integration import database, db  # noqa: F401

from app import commands
from app.core.config import settings


def test_indexing_generates_stores_and_resumes(db, monkeypatch):  # noqa: F811
    inputs = []

    @contextmanager
    def connection():
        yield db

    def embed(text):
        inputs.append(text)
        return [0.25] * 1024

    monkeypatch.setattr(commands, "connect", connection)
    monkeypatch.setattr(commands.bedrock, "embed", embed)
    assert commands.index_pending(2) == 2
    assert commands.index_pending(1) == 1
    assert len(inputs) == 3
    rows = db.execute(
        """SELECT embedding_model, vector_dims(embedding) AS dimensions
        FROM messages WHERE embedding IS NOT NULL"""
    ).fetchall()
    assert len(rows) == 3
    assert all(row["dimensions"] == 1024 for row in rows)
    assert all(
        row["embedding_model"] == settings.BEDROCK_EMBEDDING_MODEL_ID for row in rows
    )
