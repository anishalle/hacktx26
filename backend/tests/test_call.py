"""Compatibility routes must use the same persisted call service as the UI."""

from collections import deque
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.api.routes.calls import get_call_service
from app.calls.schemas import Explanation
from app.core import bedrock
from app.main import app

CALL_ID = "136fd4bf-1a44-466d-a087-990ac7f06a7f"
BASE = {"call_id": CALL_ID, "user_id": "me", "at_ms": 1700000000000}
ENTRY = {
    "speaker_id": "s1",
    "speaker_name": "Sam",
    "text": "Meet at seven.",
    "start_ms": 1699999998000,
    "end_ms": 1699999999000,
}


@pytest.fixture
def service():
    instance = Mock()
    instance.explain.return_value = Explanation(
        answer="A stored answer.",
        status="explained",
        source="conversation",
        source_result_ids=["stored"],
    )
    app.dependency_overrides[get_call_service] = lambda: instance
    yield instance
    app.dependency_overrides.pop(get_call_service)


def test_legacy_explain_reads_service_not_client_supplied_text(service):
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/explain/call",
            json={**BASE, "recent_transcript": [ENTRY]},
            headers={"X-Call-Token": "participant-token"},
        )
    assert response.status_code == 200
    assert response.json()["answer"] == "A stored answer."
    args = service.explain.call_args.args
    assert args[0:2] == (CALL_ID, "participant-token")
    assert args[2].pending_results == []
    assert args[2].at_ms == BASE["at_ms"]


def test_legacy_question_preserves_follow_up(service):
    with TestClient(app) as client:
        client.post(
            "/api/v1/explain/call",
            json={**BASE, "follow_up": "What time?"},
            headers={"X-Call-Token": "token"},
        )
    assert service.explain.call_args.args[2].follow_up == "What time?"


def test_legacy_storage_uses_stable_ids_and_preserves_speaker(service):
    with TestClient(app) as client:
        for _ in range(2):
            response = client.post(
                f"/api/v1/calls/{CALL_ID}/transcript",
                json=ENTRY,
                headers={"X-Call-Token": "token"},
            )
            assert response.json()["stored"]
    first = service.ingest.call_args_list[0].args[2][0]
    second = service.ingest.call_args_list[1].args[2][0]
    assert first.result_id == second.result_id
    assert first.alternatives[0].items[0].attendee.external_user_id == "Sam"


def test_legacy_suggestions_use_stored_context_service(service):
    service.suggest.return_value = []
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/suggest/call",
            json={**BASE, "silence_duration_ms": 45000},
            headers={"X-Call-Token": "token"},
        )
    assert response.json() == []
    assert service.suggest.call_args.args[0:2] == (CALL_ID, "token")


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
