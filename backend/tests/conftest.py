from collections import deque

import pytest

from app.core import bedrock


@pytest.fixture(autouse=True)
def isolated_model_budget(monkeypatch):
    monkeypatch.setattr(bedrock, "_request_timestamps", deque())
    monkeypatch.setattr(bedrock, "_hourly_timestamps", deque())
