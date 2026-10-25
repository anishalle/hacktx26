import json
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.api.routes.calls import get_call_service
from app.calls.schemas import ExplainCall, TranscriptResult
from app.calls.service import CallService, transcript_lines
from app.core.config import Settings, settings
from app.main import app

NOW = 1_700_000_000_000
CALL_ID = "136fd4bf-1a44-466d-a087-990ac7f06a7f"


def row(result_id, text, start, end):
    return {
        "result_id": result_id,
        "text": text,
        "start_ms": start,
        "end_ms": end,
        "items": [],
        "is_partial": False,
    }


@pytest.fixture
def service(monkeypatch):
    monkeypatch.setattr("app.calls.service.time.time", lambda: NOW / 1000)
    instance = object.__new__(CallService)
    instance.settings = Settings()
    instance.repository = Mock()
    instance.repository.call.return_value = {
        "id": CALL_ID,
        "meeting_id": "meeting",
        "started_ms": NOW - 60_000,
        "ended_at": None,
    }
    instance.repository.member.return_value = {"is_host": True}
    instance.repository.recent.return_value = []
    instance.chime = Mock()
    instance.bedrock = Mock()
    return instance


@pytest.fixture
def client(service, monkeypatch):
    monkeypatch.setattr(settings, "CALLS_DEMO_API_KEY", "test-demo-key")
    app.dependency_overrides[get_call_service] = lambda: service
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.pop(get_call_service)


def model_response(service, **fields):
    service.bedrock.converse.return_value = {
        "output": {"message": {"content": [{"text": json.dumps(fields)}]}},
    }


def test_word_clipping_and_speaker_attribution():
    entry = row("r1", "old recent future", NOW - 20_000, NOW + 2000)
    entry["items"] = [
        {
            "startTimeMs": start,
            "endTimeMs": end,
            "content": text,
            "type": "pronunciation",
            "attendee": {"externalUserId": speaker, "attendeeId": speaker},
        }
        for text, start, end, speaker in [
            ("old", NOW - 20_000, NOW - 19_000, "alice"),
            ("recent", NOW - 2000, NOW - 1000, "bob"),
            ("future", NOW + 1000, NOW + 2000, "alice"),
        ]
    ]
    lines = transcript_lines([entry], NOW - 10_000, NOW)
    assert [(line["speaker"], line["text"]) for line in lines] == [("bob", "recent")]


def test_no_speech_skips_bedrock(service):
    answer = service.explain(CALL_ID, "token", ExplainCall(at_ms=NOW))
    assert answer.status == "no_recent_speech"
    service.bedrock.converse.assert_not_called()


def test_focus_and_background_are_separate(service):
    service.repository.recent.return_value = [
        row("definition", "Grandma means Swayam's house.", NOW - 40_000, NOW - 35_000),
        row("question", "Grandma's after the game.", NOW - 4000, NOW - 2000),
    ]
    model_response(
        service,
        answer="Grandma's means Swayam's house.",
        status="explained",
        source="conversation",
        source_result_ids=["definition"],
    )
    answer = service.explain(CALL_ID, "token", ExplainCall(at_ms=NOW))
    assert answer.source_result_ids == ["definition"]
    prompt = json.loads(
        service.bedrock.converse.call_args.kwargs["messages"][0]["content"][0]["text"]
    )
    assert [line["result_id"] for line in prompt["focus"]] == ["question"]
    assert [line["result_id"] for line in prompt["background"]] == ["definition"]


def test_fabricated_model_source_is_rejected(service):
    service.repository.recent.return_value = [
        row("question", "Grandma's after the game.", NOW - 4000, NOW - 2000),
    ]
    model_response(
        service,
        answer="Grandma is Alex.",
        status="explained",
        source="conversation",
        source_result_ids=["not-in-this-call"],
    )
    assert service.explain(CALL_ID, "token", ExplainCall(at_ms=NOW)).status == "unclear"


def test_pending_partial_is_stored_before_explanation_lookup(service):
    pending = TranscriptResult.model_validate(
        {
            "resultId": "pending",
            "isPartial": True,
            "startTimeMs": NOW - 2000,
            "endTimeMs": NOW - 1000,
            "alternatives": [{"transcript": "What does that mean?", "items": []}],
        }
    )
    service.explain(CALL_ID, "token", ExplainCall(at_ms=NOW, pending_results=[pending]))
    methods = [method[0] for method in service.repository.method_calls]
    assert methods.index("store") < methods.index("recent")


def test_normal_ingestion_skips_partial_results(service):
    partial = TranscriptResult.model_validate(
        {
            "resultId": "p1",
            "isPartial": True,
            "startTimeMs": NOW - 2000,
            "endTimeMs": NOW - 1000,
            "alternatives": [{"transcript": "hello", "items": []}],
        }
    )
    assert service.ingest(CALL_ID, "token", [partial]) == {"accepted_results": 0}
    service.repository.store.assert_not_called()


def test_non_host_cannot_start_transcription(service):
    service.repository.member.return_value = {"is_host": False}
    with pytest.raises(HTTPException) as exc:
        service.start_transcription(CALL_ID, "token")
    assert exc.value.status_code == 403
    service.chime.start_meeting_transcription.assert_not_called()


def test_create_failure_deletes_meeting(service):
    service.chime.create_meeting.return_value = {"Meeting": {"MeetingId": "meeting"}}
    service.chime.create_attendee.return_value = {
        "Attendee": {"AttendeeId": "attendee"}
    }
    service.repository.create.side_effect = RuntimeError("database down")
    with pytest.raises(RuntimeError):
        service.create("group", "user")
    service.chime.delete_meeting.assert_called_once_with(MeetingId="meeting")


def test_http_demo_key_and_call_token_are_required(client):
    assert (
        client.post("/api/v1/calls", json={"group_id": "g", "user_id": "u"}).status_code
        == 401
    )
    assert (
        client.post(f"/api/v1/calls/{CALL_ID}/explain", json={"at_ms": NOW}).status_code
        == 401
    )


def test_invalid_call_token_cannot_read_transcript(client, service):
    service.repository.member.return_value = None
    response = client.get(
        f"/api/v1/calls/{CALL_ID}/transcripts",
        headers={"X-Call-Token": "wrong"},
    )
    assert response.status_code == 403
    service.repository.recent.assert_not_called()


def test_invalid_word_timestamps_are_rejected(client):
    response = client.post(
        f"/api/v1/calls/{CALL_ID}/transcripts",
        headers={"X-Call-Token": "token"},
        json={
            "results": [
                {
                    "resultId": "bad",
                    "isPartial": False,
                    "startTimeMs": NOW,
                    "endTimeMs": NOW - 1,
                    "alternatives": [{"transcript": "hello"}],
                }
            ]
        },
    )
    assert response.status_code == 422


@pytest.mark.parametrize(
    "word_start,word_end", [(NOW - 2100, NOW - 1500), (NOW - 1500, NOW - 900)]
)
def test_chime_word_bounds_expand_segment_before_storage(
    client, service, word_start, word_end
):
    response = client.post(
        f"/api/v1/calls/{CALL_ID}/transcripts",
        headers={"X-Call-Token": "token"},
        json={
            "results": [
                {
                    "resultId": "chime-boundary",
                    "isPartial": False,
                    "startTimeMs": NOW - 2000,
                    "endTimeMs": NOW - 1000,
                    "alternatives": [
                        {
                            "transcript": "hello",
                            "items": [
                                {
                                    "type": "pronunciation",
                                    "content": "hello",
                                    "startTimeMs": word_start,
                                    "endTimeMs": word_end,
                                    "attendee": {"attendeeId": "speaker"},
                                }
                            ],
                        }
                    ],
                }
            ]
        },
    )
    assert response.status_code == 200
    saved = service.repository.store.call_args.args[1]
    assert saved.start_time_ms == min(NOW - 2000, word_start)
    assert saved.end_time_ms == max(NOW - 1000, word_end)
    word = saved.alternatives[0].items[0]
    assert (word.start_time_ms, word.end_time_ms) == (word_start, word_end)


def test_reversed_chime_word_end_is_normalized_to_its_start():
    result = TranscriptResult.model_validate(
        {
            "resultId": "invalid-word",
            "isPartial": False,
            "startTimeMs": NOW - 2000,
            "endTimeMs": NOW - 1000,
            "alternatives": [
                {
                    "transcript": "hello",
                    "items": [
                        {
                            "content": "hello",
                            "startTimeMs": NOW - 1000,
                            "endTimeMs": NOW - 1500,
                            "attendee": {"attendeeId": "speaker"},
                        }
                    ],
                }
            ],
        }
    )
    word = result.alternatives[0].items[0]
    assert word.start_time_ms == NOW - 1000
    assert word.end_time_ms == word.start_time_ms
