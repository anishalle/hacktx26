"""PostgreSQL/pgvector tests. Set TEST_DATABASE_URL to a disposable database."""

import json
import os

import psycopg
import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from psycopg.rows import dict_row

from app import bedrock, repository
from app.commands import seed
from app.core.config import settings
from app.core.db import get_db
from app.main import app


@pytest.fixture(scope="module")
def database():
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip(
            "Set TEST_DATABASE_URL for real PostgreSQL/pgvector integration tests"
        )
    previous = settings.DATABASE_URL
    settings.DATABASE_URL = url
    try:
        command.upgrade(Config("alembic.ini"), "head")
        seed()
        yield url
    finally:
        settings.DATABASE_URL = previous


@pytest.fixture
def db(database):
    connection = psycopg.connect(database, row_factory=dict_row)
    try:
        yield connection
    finally:
        connection.rollback()
        connection.close()


@pytest.fixture
def client(db):
    def connection():
        yield db

    app.dependency_overrides[get_db] = connection
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def headers(user):
    return {"X-Demo-User": user}


def test_full_100_on_both_sides_with_timestamp_ties_and_group_isolation(db):
    db.execute("INSERT INTO groups VALUES ('other', 'Another group')")
    db.execute("INSERT INTO memberships VALUES ('other', 'alex', now())")
    db.execute("""INSERT INTO messages (id, group_id, sender_id, ts, text)
        SELECT 'tie-' || lpad(i::text, 3, '0'), 'other', 'alex',
               '2025-01-01'::timestamptz, 'Tied message'
        FROM generate_series(0, 250) AS i""")
    anchor = repository.message(db, "other", "tie-125")
    rows = repository.window(db, anchor)
    assert len(rows) == 201
    assert rows[0]["id"] == "tie-025"
    assert rows[100]["id"] == "tie-125"
    assert rows[-1]["id"] == "tie-225"
    assert {row["group_id"] for row in rows} == {"other"}
    start = repository.window(db, repository.message(db, "other", "tie-000"))
    end = repository.window(db, repository.message(db, "other", "tie-250"))
    assert len(start) == len(end) == 101


def test_pgvector_and_keyword_search_stay_in_group(db):
    vec = [1.0] + [0.0] * 1023
    literal = repository.vector_literal(vec)
    db.execute(
        """UPDATE messages SET embedding = %s::vector, embedding_model = %s
        WHERE id = 'demo-0025'""",
        (literal, settings.BEDROCK_EMBEDDING_MODEL_ID),
    )
    hits = repository.search(db, repository.message(db, "longhorns", "demo-0435"), vec)
    assert "demo-0025" in {row["id"] for row in hits}
    assert all(row["group_id"] == "longhorns" for row in hits)


def test_paging_send_and_source_navigation(client):
    latest = client.get("/api/v1/groups/longhorns/messages?limit=10").json()
    assert len(latest["messages"]) == 10 and latest["has_more"]
    before = latest["messages"][0]["id"]
    older = client.get(
        f"/api/v1/groups/longhorns/messages?limit=10&before={before}"
    ).json()
    assert not {m["id"] for m in older["messages"]} & {
        m["id"] for m in latest["messages"]
    }
    around = client.get("/api/v1/groups/longhorns/messages?around=demo-0025").json()
    assert "demo-0025" in {row["id"] for row in around["messages"]}
    sent = client.post(
        "/api/v1/groups/longhorns/messages", json={"text": "Hello there!"}
    )
    assert sent.status_code == 201 and sent.json()["sender_id"] == "priya"
    assert (
        client.post(
            "/api/v1/groups/longhorns/messages", json={"text": "   "}
        ).status_code
        == 422
    )
    assert client.get("/api/v1/groups/missing/messages").status_code == 403


def test_private_ask_reply_decline_and_no_public_post(client, db):
    count = db.execute("SELECT count(*) AS n FROM messages").fetchone()["n"]
    payload = {
        "group_id": "longhorns",
        "message_id": "demo-0437",
        "question": "What is the moon waffle?",
    }
    created = client.post("/api/v1/ask-member", json=payload)
    assert created.status_code == 201
    ask_id = created.json()["id"]
    assert created.json()["recipient_id"] == "swayam"
    # Double taps create one request.
    assert client.post("/api/v1/ask-member", json=payload).json()["id"] == ask_id
    path = "/api/v1/groups/longhorns/member-asks"
    assert any(
        a["id"] == ask_id for a in client.get(path, headers=headers("swayam")).json()
    )
    assert all(
        a["id"] != ask_id for a in client.get(path, headers=headers("alex")).json()
    )
    answer_path = f"/api/v1/ask-member/{ask_id}/answer"
    assert (
        client.post(
            answer_path, headers=headers("alex"), json={"answer": "Spoofed reply"}
        ).status_code
        == 404
    )
    assert client.post(answer_path, json={"answer": "Self reply"}).status_code == 404
    answered = client.post(
        answer_path,
        headers=headers("swayam"),
        json={"answer": "It's our waffle-shaped frisbee."},
    )
    assert answered.status_code == 200 and answered.json()["status"] == "answered"
    assert (
        client.post(
            answer_path, headers=headers("swayam"), json={"answer": "Second reply"}
        ).status_code
        == 409
    )
    assert repository.private_answers(db, "longhorns", "demo-0437", "priya")
    assert not repository.private_answers(db, "longhorns", "demo-0437", "alex")
    db.execute(
        """INSERT INTO messages (id, group_id, sender_id, ts, text)
        VALUES ('new-reference', 'longhorns', 'swayam', now(),
                'Is anyone bringing the moon waffle?')"""
    )
    reused = repository.private_answers(db, "longhorns", "new-reference", "priya")
    assert reused[0]["id"] == ask_id
    assert not repository.private_answers(db, "longhorns", "new-reference", "alex")
    db.execute("DELETE FROM messages WHERE id = 'new-reference'")
    second = client.post("/api/v1/ask-member", json={**payload, "question": "Another?"})
    declined = client.post(
        f"/api/v1/ask-member/{second.json()['id']}/answer",
        headers=headers("swayam"),
        json={"decline": True},
    )
    assert declined.json()["status"] == "declined"
    assert db.execute("SELECT count(*) AS n FROM messages").fetchone()["n"] == count


def test_grounded_explain_and_follow_up_reuse_context(client, db, monkeypatch):
    calls = []
    monkeypatch.setattr(bedrock, "embed", lambda text: [0.1] * 1024)

    def explain(payload):
        calls.append(json.loads(json.dumps(payload, default=str)))
        return {
            "meaning": "**Grandma** is Swayam's house.",
            "confidence": 0.95,
            "kind": "nickname",
            "source_message_ids": ["demo-0025"],
        }

    monkeypatch.setattr(bedrock, "explain", explain)
    request = {"group_id": "longhorns", "message_id": "demo-0435"}
    response = client.post("/api/v1/explain/message", json=request)
    assert response.status_code == 200
    answer = response.json()
    assert answer["kind"] == "nickname"
    assert answer["sources"][0]["id"] == "demo-0025"
    assert len(calls[0]["history"]) > 201
    follow = client.post(
        "/api/v1/explain/message",
        json={
            **request,
            "explanation_id": answer["id"],
            "follow_up": "Whose house?",
        },
    )
    assert follow.status_code == 200
    assert calls[0]["history"] == calls[1]["history"]
    # Saved contexts cannot be accessed by another demo user.
    assert (
        client.post(
            "/api/v1/explain/message",
            headers=headers("alex"),
            json={
                **request,
                "explanation_id": answer["id"],
                "follow_up": "Show it",
            },
        ).status_code
        == 404
    )
    assert db.execute("SELECT count(*) AS n FROM member_asks").fetchone()["n"] == 0


def test_model_unknown_and_invalid_citations_show_fallback(client, monkeypatch):
    monkeypatch.setattr(bedrock, "embed", lambda text: [0.1] * 1024)
    monkeypatch.setattr(
        bedrock,
        "explain",
        lambda payload: {
            "meaning": "Made up",
            "confidence": 0.99,
            "kind": "slang",
            "source_message_ids": ["nonexistent"],
        },
    )
    result = client.post(
        "/api/v1/explain/message",
        json={
            "group_id": "longhorns",
            "message_id": "demo-0437",
        },
    )
    assert result.status_code == 200
    assert result.json()["kind"] == "unknown"
    assert result.json()["can_ask_sender"] is True


def test_bedrock_failure_is_actionable(client, monkeypatch):
    from botocore.exceptions import NoCredentialsError

    def unavailable(text):
        raise NoCredentialsError()

    monkeypatch.setattr(bedrock, "embed", unavailable)
    response = client.post(
        "/api/v1/explain/message",
        json={
            "group_id": "longhorns",
            "message_id": "demo-0435",
        },
    )
    assert response.status_code == 503
    assert "AWS session" in response.json()["detail"]
