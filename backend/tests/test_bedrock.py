import io
import json

import boto3
from botocore.stub import Stubber

from app import bedrock
from app.core.config import settings


def runtime():
    return boto3.client(
        "bedrock-runtime",
        region_name="us-east-1",
        aws_access_key_id="testing",
        aws_secret_access_key="testing",
    )


def test_embedding_uses_titan_with_1024_dimensions(monkeypatch):
    client = runtime()
    monkeypatch.setattr(bedrock, "client", lambda: client)
    vector = [0.25] * 1024
    with Stubber(client) as stub:
        stub.add_response(
            "invoke_model",
            {
                "body": io.BytesIO(json.dumps({"embedding": vector}).encode()),
                "contentType": "application/json",
            },
            {
                "modelId": settings.BEDROCK_EMBEDDING_MODEL_ID,
                "contentType": "application/json",
                "accept": "application/json",
                "body": json.dumps(
                    {
                        "inputText": "Grandma",
                        "dimensions": 1024,
                        "normalize": True,
                    }
                ),
            },
        )
        assert bedrock.embed("Grandma") == vector


def test_claude_runs_through_bedrock_converse(monkeypatch):
    calls = []

    class Client:
        def converse(self, **kwargs):
            calls.append(kwargs)
            return {
                "output": {
                    "message": {
                        "content": [
                            {
                                "text": json.dumps(
                                    {
                                        "meaning": "Plain language.",
                                        "kind": "plain",
                                        "confidence": 0.9,
                                    }
                                )
                            }
                        ]
                    }
                }
            }

    monkeypatch.setattr(bedrock, "client", Client)
    monkeypatch.setattr(settings, "BEDROCK_CLAUDE_MODEL_ID", "test-claude-profile")
    assert bedrock.explain({"selected": {"text": "see you"}})["kind"] == "plain"
    assert calls[0]["modelId"] == "test-claude-profile"
