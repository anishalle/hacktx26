"""Compatibility routes for the mobile UI, backed by the canonical call store."""

import hashlib
import time
from uuid import UUID

from fastapi import APIRouter

from app.api.routes.calls import CallToken, Service, aws_operation
from app.calls.schemas import ExplainCall, SuggestCall, TranscriptResult
from app.models import (
    ExplainCallRequest,
    ExplainCallResponse,
    SilenceSuggestionRequest,
    StoreTranscriptRequest,
    SuggestionItem,
)

router = APIRouter(tags=["call"])


@router.post("/explain/call", response_model=ExplainCallResponse)
def explain_call(
    req: ExplainCallRequest, service: Service, x_call_token: CallToken = ""
):
    # recent_transcript is accepted for old clients, but answers read the database.
    call_id = str(req.call_id)
    answer = aws_operation(
        lambda: service.explain(
            call_id,
            x_call_token,
            ExplainCall(
                at_ms=req.at_ms if req.at_ms is not None else int(time.time() * 1000),
                follow_up=req.follow_up,
            ),
        )
    )
    return ExplainCallResponse(
        answer=answer.answer,
        confidence=0,
        kind="general",
        status=answer.status,
        source=answer.source,
        source_result_ids=answer.source_result_ids,
    )


@router.post("/calls/{call_id}/transcript")
def store_transcript(
    call_id: UUID,
    req: StoreTranscriptRequest,
    service: Service,
    x_call_token: CallToken = "",
):
    result_id = (
        req.result_id
        or hashlib.sha256(
            f"{call_id}:{req.speaker_id}:{req.start_ms}:{req.end_ms}:{req.text}".encode(),
        ).hexdigest()
    )
    result = TranscriptResult.model_validate(
        {
            "resultId": result_id,
            "isPartial": False,
            "startTimeMs": req.start_ms,
            "endTimeMs": req.end_ms,
            "alternatives": [
                {
                    "transcript": req.text,
                    "items": [
                        {
                            "type": "pronunciation",
                            "startTimeMs": req.start_ms,
                            "endTimeMs": req.end_ms,
                            "content": req.text,
                            "attendee": {
                                "attendeeId": req.speaker_id,
                                "externalUserId": req.speaker_name,
                            },
                        }
                    ],
                }
            ],
        }
    )
    aws_operation(lambda: service.ingest(str(call_id), x_call_token, [result]))
    return {"status": "stored", "stored": True}


@router.post("/suggest/call", response_model=list[SuggestionItem])
def suggest_call(
    req: SilenceSuggestionRequest, service: Service, x_call_token: CallToken = ""
):
    return aws_operation(
        lambda: service.suggest(
            str(req.call_id),
            x_call_token,
            SuggestCall(
                at_ms=req.at_ms if req.at_ms is not None else int(time.time() * 1000),
                silence_duration_ms=req.silence_duration_ms,
            ),
        )
    )
