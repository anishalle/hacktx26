"""Exercise the merged mobile route through stored evidence and the real SDK shape."""

import json
from unittest.mock import Mock

import boto3
import pytest
from botocore.stub import ANY, Stubber
from fastapi.testclient import TestClient

from app.api.routes.calls import get_call_service
from app.calls.service import CallService
from app.core.config import Settings
from app.main import app

CALL_ID = "136fd4bf-1a44-466d-a087-990ac7f06a7f"
NOW = 1700000000000


@pytest.fixture
def pipeline():
    runtime = boto3.client(
        "bedrock-runtime",
        region_name="us-east-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
    )
    service = object.__new__(CallService)
    service.settings = Settings()
    service.bedrock = runtime
    service.repository = Mock()
    service.repository.member.return_value = {"is_host": True}
    service.repository.call.return_value = {"ended_at": None}
    service.repository.recent.return_value = [
        {
            "result_id": "definition",
            "text": "We call the library the nest.",
            "start_ms": NOW - 40000,
            "end_ms": NOW - 35000,
            "items": [],
            "is_partial": False,
        },
        {
            "result_id": "focus",
            "text": "Meet at the nest.",
            "start_ms": NOW - 4000,
            "end_ms": NOW - 2000,
            "items": [],
            "is_partial": False,
        },
    ]
    app.dependency_overrides[get_call_service] = lambda: service
    yield service, runtime
    app.dependency_overrides.pop(get_call_service)


@pytest.mark.parametrize("question", [None, "What does the nest refer to?"])
def test_route_reads_database_then_calls_bedrock(pipeline, question):
    service, runtime = pipeline
    reply = json.dumps(
        {
            "answer": "The nest means the library.",
            "status": "explained",
            "source": "conversation",
            "source_result_ids": ["definition"],
        }
    )
    captured = {}
    runtime.meta.events.register(
        "before-parameter-build.bedrock-runtime.Converse",
        lambda params, **kwargs: captured.update(params),
    )
    with Stubber(runtime) as stub:
        stub.add_response(
            "converse",
            {
                "output": {
                    "message": {"role": "assistant", "content": [{"text": reply}]}
                },
                "stopReason": "end_turn",
                "usage": {"inputTokens": 100, "outputTokens": 40, "totalTokens": 140},
                "metrics": {"latencyMs": 1},
            },
            {
                "modelId": service.settings.GENERATION_MODEL_ID,
                "system": ANY,
                "messages": ANY,
                "inferenceConfig": {"maxTokens": 200, "temperature": 0},
            },
        )
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/explain/call",
                json={
                    "call_id": CALL_ID,
                    "user_id": "me",
                    "at_ms": NOW,
                    "follow_up": question,
                    "recent_transcript": [
                        {
                            "speaker_id": "x",
                            "speaker_name": "X",
                            "text": "Fabricated client-only context",
                            "start_ms": NOW - 1000,
                            "end_ms": NOW,
                        }
                    ],
                },
                headers={"X-Call-Token": "token"},
            )
        stub.assert_no_pending_responses()
    assert response.status_code == 200, response.json()
    assert response.json()["answer"] == "The nest means the library."
    service.repository.recent.assert_called_once_with(CALL_ID, NOW - 120000, NOW)
    evidence = json.loads(captured["messages"][0]["content"][0]["text"])
    assert evidence["question"] == question
    assert any(line["text"] == "Meet at the nest." for line in evidence["focus"])
    assert "Fabricated" not in str(evidence)
    assert "Never invent" in captured["system"][0]["text"]


def test_access_denied_is_not_an_answer(pipeline):
    _, runtime = pipeline
    with Stubber(runtime) as stub:
        stub.add_client_error("converse", service_error_code="AccessDeniedException")
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/explain/call",
                json={"call_id": CALL_ID, "user_id": "me", "at_ms": NOW},
                headers={"X-Call-Token": "token"},
            )
    assert response.status_code == 502
    assert "answer" not in response.json()
