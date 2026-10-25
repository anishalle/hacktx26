from collections import deque
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.api.routes import call
from app.core import bedrock
from app.main import app

client = TestClient(app)
ENTRY = {
    "speaker_id": "s1",
    "speaker_name": "Sam",
    "text": "Meet at seven.",
    "start_ms": 1,
    "end_ms": 2000,
}
BASE = {"call_id": "test", "user_id": "me"}


def test_empty_transcript_skips_model(monkeypatch):
    model = Mock(side_effect=AssertionError("No paid call expected"))
    monkeypatch.setattr(call, "invoke_model", model)
    result = client.post("/api/v1/explain/call", json=BASE)
    assert result.status_code == 200
    assert "No recent speech" in result.json()["answer"]
    assert not model.called


def test_explanation_uses_supplied_evidence(monkeypatch):
    model = Mock(return_value="Sam suggested meeting at seven.")
    monkeypatch.setattr(call, "invoke_model", model)
    result = client.post(
        "/api/v1/explain/call", json={**BASE, "recent_transcript": [ENTRY]}
    )
    assert result.json()["answer"] == "Sam suggested meeting at seven."
    assert "No group history has been retrieved" in model.call_args.args[0]
    assert ENTRY["text"] in model.call_args.args[0]


def test_model_failure_is_not_a_fake_answer(monkeypatch):
    monkeypatch.setattr(
        call, "invoke_model", Mock(side_effect=RuntimeError("unavailable"))
    )
    result = client.post(
        "/api/v1/explain/call", json={**BASE, "recent_transcript": [ENTRY]}
    )
    assert result.status_code == 502
    assert "answer" not in result.json()


def test_unconfigured_storage_reports_failure(monkeypatch):
    monkeypatch.setattr(call.settings, "DATABASE_CLUSTER_ARN", "")
    assert client.post("/api/v1/calls/test/transcript", json=ENTRY).status_code == 503


def test_storage_preserves_speaker_and_text(monkeypatch):
    monkeypatch.setattr(call.settings, "DATABASE_CLUSTER_ARN", "test-arn")
    sql = Mock(return_value={})
    monkeypatch.setattr(call, "execute_sql", sql)
    assert client.post("/api/v1/calls/test/transcript", json=ENTRY).json()["stored"]
    params = {p["name"]: p["value"] for p in sql.call_args.kwargs["parameters"]}
    assert params["speaker_id"] == {"stringValue": "s1"}
    assert params["text"] == {"stringValue": ENTRY["text"]}


def test_invalid_suggestions_are_not_fabricated(monkeypatch):
    monkeypatch.setattr(call, "invoke_model", Mock(return_value="not JSON"))
    result = client.post(
        "/api/v1/suggest/call",
        json={**BASE, "silence_duration_ms": 50000, "recent_transcript": [ENTRY]},
    )
    assert result.json() == []


def test_nova_converse_contract_and_budget(monkeypatch):
    model = Mock()
    model.converse.return_value = {
        "output": {"message": {"content": [{"text": "A short answer."}]}}
    }
    monkeypatch.setattr(bedrock, "get_bedrock_client", lambda: model)
    monkeypatch.setattr(bedrock, "_request_timestamps", deque())
    monkeypatch.setattr(bedrock, "_hourly_timestamps", deque())
    assert bedrock.invoke_model("Explain this", max_tokens=10000) == "A short answer."
    args = model.converse.call_args.kwargs
    assert (
        args["inferenceConfig"]["maxTokens"]
        == bedrock.settings.MAX_OUTPUT_TOKENS_PER_REQUEST
    )
    assert args["system"] and args["messages"]
    with pytest.raises(ValueError):
        bedrock.invoke_model(
            "x" * (bedrock.settings.MAX_INPUT_TOKENS_PER_REQUEST * 4 + 4)
        )
