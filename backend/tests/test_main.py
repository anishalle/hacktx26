from fastapi.testclient import TestClient

from app.api.routes.calls import get_call_service
from app.main import app


def test_health_and_openapi() -> None:
    with TestClient(app) as client:
        response = client.get("/api/v1/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
        schema = client.get("/api/v1/openapi.json")
        assert schema.status_code == 200
        assert "/api/v1/health" in schema.json()["paths"]


def test_validation_logs_fields_without_request_secrets(caplog) -> None:
    app.dependency_overrides[get_call_service] = lambda: None
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/calls/example/explain",
                json={"at_ms": "private-transcript-sentinel"},
                headers={"X-Call-Token": "private-token-sentinel"},
            )
    finally:
        app.dependency_overrides.pop(get_call_service)
    assert response.status_code == 422
    assert "at_ms" in caplog.text
    assert "int_parsing" in caplog.text
    assert "private-transcript-sentinel" not in caplog.text
    assert "private-token-sentinel" not in caplog.text
