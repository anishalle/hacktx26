import importlib.util
from pathlib import Path

import httpcore
import httpx
import pytest
from httpcore._backends.sync import SyncBackend


@pytest.fixture
def verifier():
    path = Path(__file__).resolve().parents[2] / "infra/verify_calls.py"
    spec = importlib.util.spec_from_file_location("call_verifier", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fake_network(monkeypatch, *, failed_handshakes=0, read_timeout=False, status=200):
    state = {"connections": 0, "handshakes": 0, "writes": []}

    class Stream:
        def start_tls(self, **kwargs):
            state["handshakes"] += 1
            if state["handshakes"] <= failed_handshakes:
                raise httpcore.ConnectTimeout("TLS handshake timed out")
            return self

        def write(self, buffer, **kwargs):
            state["writes"].append(buffer)

        def read(self, max_bytes, **kwargs):
            if read_timeout:
                raise httpcore.ReadTimeout("No response after sending request")
            return (
                f"HTTP/1.1 {status} Test\r\nContent-Length: 11\r\n\r\n".encode()
                + b'{"ok":true}'
            )

        def get_extra_info(self, name):
            return None

        def close(self):
            pass

    def connect(self, **kwargs):
        state["connections"] += 1
        return Stream()

    monkeypatch.setattr(SyncBackend, "connect_tcp", connect)
    monkeypatch.setattr(SyncBackend, "sleep", lambda self, seconds: None)
    return state


def test_handshake_timeout_recovers_without_duplicate_post(verifier, monkeypatch):
    state = fake_network(monkeypatch, failed_handshakes=1)

    def verify(client):
        assert client.post("https://test.invalid/calls", json={"hello": "world"}).json()

    monkeypatch.setattr(verifier, "verify", verify)
    verifier.main()
    assert state["handshakes"] == 2
    assert b"".join(state["writes"]).count(b'"hello":"world"') == 1


def test_handshake_retries_are_bounded(verifier, monkeypatch):
    state = fake_network(monkeypatch, failed_handshakes=100)
    monkeypatch.setattr(
        verifier,
        "verify",
        lambda client: client.post("https://test.invalid/calls"),
    )
    with pytest.raises(httpx.ConnectTimeout):
        verifier.main()
    assert state["handshakes"] == 3
    assert state["writes"] == []


def test_read_timeout_does_not_resend_post(verifier, monkeypatch):
    state = fake_network(monkeypatch, read_timeout=True)
    monkeypatch.setattr(
        verifier,
        "verify",
        lambda client: client.post("https://test.invalid/calls"),
    )
    with pytest.raises(httpx.ReadTimeout):
        verifier.main()
    assert state["connections"] == 1


def test_server_error_is_not_retried(verifier, monkeypatch):
    state = fake_network(monkeypatch, status=500)

    def verify(client):
        assert client.post("https://test.invalid/calls").status_code == 500

    monkeypatch.setattr(verifier, "verify", verify)
    verifier.main()
    assert state["connections"] == 1


def test_requests_reuse_tls_connection(verifier, monkeypatch):
    state = fake_network(monkeypatch)

    def verify(client):
        client.post("https://test.invalid/calls")
        client.post("https://test.invalid/transcripts")

    monkeypatch.setattr(verifier, "verify", verify)
    verifier.main()
    assert state["handshakes"] == 1
