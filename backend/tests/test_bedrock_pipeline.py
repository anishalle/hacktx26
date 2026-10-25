"""Verify the HTTP route builds valid Bedrock requests without AWS/network access."""

from collections import deque

import boto3
import pytest
from botocore.stub import ANY, Stubber
from fastapi.testclient import TestClient

from app.core import bedrock
from app.main import app


@pytest.mark.parametrize("question", [None, "What does the nest refer to?"])
def test_route_to_bedrock_roundtrip(monkeypatch, question):
    runtime = boto3.client(
        "bedrock-runtime",
        region_name="us-east-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
    )
    captured = {}

    def capture(params, **kwargs):
        captured.update(params)

    runtime.meta.events.register(
        "before-parameter-build.bedrock-runtime.Converse", capture
    )
    monkeypatch.setattr(bedrock, "_client", runtime)
    monkeypatch.setattr(bedrock, "_request_timestamps", deque())
    monkeypatch.setattr(bedrock, "_hourly_timestamps", deque())
    reply = '"The nest" is their nickname for the library.'
    expected = {
        "modelId": bedrock.settings.GENERATION_MODEL_ID,
        "system": ANY,
        "messages": ANY,
        "inferenceConfig": {"maxTokens": 150 if question else 80, "temperature": 0},
    }
    with Stubber(runtime) as stub:
        stub.add_response(
            "converse",
            {
                "output": {
                    "message": {"role": "assistant", "content": [{"text": reply}]}
                },
                "stopReason": "end_turn",
                "usage": {"inputTokens": 100, "outputTokens": 15, "totalTokens": 115},
                "metrics": {"latencyMs": 1},
            },
            expected,
        )
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/explain/call",
                json={
                    "call_id": "contract-test",
                    "user_id": "test-user",
                    "follow_up": question,
                    "recent_transcript": [
                        {
                            "speaker_id": "sam",
                            "speaker_name": "Sam",
                            "text": "We call the library the nest.",
                            "start_ms": 0,
                            "end_ms": 2000,
                        }
                    ],
                },
            )
        stub.assert_no_pending_responses()
    assert response.status_code == 200
    assert response.json()["answer"] == reply
    prompt = captured["messages"][0]["content"][0]["text"]
    assert "[Sam]: We call the library the nest." in prompt
    assert "No group history has been retrieved" in prompt
    assert "one sentence" in prompt.lower()
    if question:
        assert question in prompt
    else:
        assert "last 10 seconds" in prompt
    assert "Never invent" in captured["system"][0]["text"]


def test_access_denied_surfaces_as_error(monkeypatch):
    runtime = boto3.client(
        "bedrock-runtime",
        region_name="us-east-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
    )
    monkeypatch.setattr(bedrock, "_client", runtime)
    monkeypatch.setattr(bedrock, "_request_timestamps", deque())
    monkeypatch.setattr(bedrock, "_hourly_timestamps", deque())
    with Stubber(runtime) as stub:
        stub.add_client_error("converse", service_error_code="AccessDeniedException")
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/explain/call",
                json={
                    "call_id": "contract-test",
                    "user_id": "test-user",
                    "recent_transcript": [
                        {
                            "speaker_id": "sam",
                            "speaker_name": "Sam",
                            "text": "Meet at seven.",
                            "start_ms": 0,
                            "end_ms": 2000,
                        }
                    ],
                },
            )
        stub.assert_no_pending_responses()
    assert response.status_code == 502
    assert "answer" not in response.json()
