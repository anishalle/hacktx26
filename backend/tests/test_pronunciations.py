from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import app
from app.pronunciations import MAX_AUDIO_BYTES

MP4 = b"\x00\x00\x00\x18ftypM4A " + b"demo-audio"
WEBM = b"\x1a\x45\xdf\xa3demo-audio"
URL = "/api/v1/users/priya/pronunciation"
HEADERS = {"X-Demo-User": "priya", "Content-Type": "audio/mp4"}


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(settings, "PRONUNCIATION_DB", tmp_path / "audio.sqlite3")
    monkeypatch.setattr(settings, "FASTAPI_ENV", "development")
    with TestClient(app) as client:
        yield client


def test_record_replace_play_delete(client):
    assert client.get(URL).status_code == 404
    assert client.get("/api/v1/users/priya").json()["pronunciation_url"] is None
    uploaded = client.put(URL, content=MP4, headers=HEADERS)
    assert uploaded.status_code == 200
    first_url = uploaded.json()["pronunciation_url"]
    audio = client.get(first_url)
    assert audio.content == MP4
    assert audio.headers["content-type"] == "audio/mp4"
    assert audio.headers["cache-control"] == "no-store"
    updated = client.put(
        URL,
        content=WEBM,
        headers={"X-Demo-User": "priya", "Content-Type": "audio/webm;codecs=opus"},
    ).json()
    assert updated["pronunciation_url"] != first_url
    # A fresh client sees the saved bytes, rather than process-local state.
    with TestClient(app) as other_client:
        assert other_client.get(updated["pronunciation_url"]).content == WEBM
        assert other_client.get("/api/v1/users").json()[0] == updated
    assert client.delete(URL, headers=HEADERS).status_code == 204
    assert client.get(URL).status_code == 404
    assert client.get("/api/v1/users/priya").json()["pronunciation_url"] is None
    assert client.delete(URL, headers=HEADERS).status_code == 204


@pytest.mark.parametrize("method", ["put", "delete"])
def test_only_owner_can_edit(client, method):
    for headers in ({}, {"X-Demo-User": "alex"}):
        assert getattr(client, method)(URL, headers=headers).status_code == 403
    assert (
        getattr(client, method)(
            "/api/v1/users/unknown/pronunciation", headers=HEADERS
        ).status_code
        == 404
    )


def test_demo_editing_disabled_outside_development(client, monkeypatch):
    monkeypatch.setattr(settings, "FASTAPI_ENV", "production")
    assert client.put(URL, content=MP4, headers=HEADERS).status_code == 403
    assert client.delete(URL, headers=HEADERS).status_code == 403


@pytest.mark.parametrize(
    "body,content_type,status",
    [
        (b"", "audio/mp4", 422),
        (b"not audio", "audio/mp4", 422),
        (MP4, "audio/webm", 422),
        (MP4, "text/html", 415),
        (MP4 + b"x" * MAX_AUDIO_BYTES, "audio/mp4", 413),
    ],
    ids=["empty", "invalid-container", "wrong-container", "unsupported", "oversized"],
)
def test_invalid_upload_preserves_existing_clip(client, body, content_type, status):
    client.put(URL, content=MP4, headers=HEADERS)
    response = client.put(
        URL,
        content=body,
        headers={"X-Demo-User": "priya", "Content-Type": content_type},
    )
    assert response.status_code == status
    assert client.get(URL).content == MP4
