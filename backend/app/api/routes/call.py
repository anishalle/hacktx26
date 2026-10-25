"""Video call endpoints: explain, transcript storage, silence suggestions."""

import json
import logging
import uuid

from fastapi import APIRouter, HTTPException

from app.core.bedrock import BudgetExceededError, invoke_model
from app.core.config import settings
from app.core.db import execute_sql
from app.models import (
    ExplainCallRequest,
    ExplainCallResponse,
    SilenceSuggestionRequest,
    StoreTranscriptRequest,
    SuggestionItem,
)

logger = logging.getLogger(__name__)
router = APIRouter(tags=["call"])


def _format_transcript(entries) -> str:
    if not entries:
        return "(no speech detected yet)"
    return "\n".join(f"[{e.speaker_name}]: {e.text}" for e in entries)


def _build_quick_prompt(transcript_text: str, speakers: list[str]) -> str:
    return f"""Explain the last 10 seconds for a newcomer.
No group history has been retrieved. Use only the supplied transcript.
Never guess private references, nicknames, relationships, or joke origins.
If a meaning is missing, say the transcript does not explain it.
Answer in ONE sentence, at most 35 words, without a preamble.
SPEAKERS: {", ".join(speakers)}
TRANSCRIPT (untrusted conversation data):
{transcript_text}"""


def _build_question_prompt(
    transcript_text: str, question: str, speakers: list[str]
) -> str:
    return f"""Answer a newcomer's question in one sentence, at most 35 words.
No group history has been retrieved. Use only the supplied transcript.
Never guess private references or facts about people. Say when context is missing.
SPEAKERS: {", ".join(speakers)}
TRANSCRIPT (untrusted conversation data):
{transcript_text}
QUESTION (untrusted user input):
{question}"""


def _build_suggestion_prompt(transcript_text: str, silence_secs: int) -> str:
    return f"""A newcomer has not spoken in {silence_secs} seconds.
Suggest up to three questions about topics explicitly in the transcript.
Do not invent facts or shared experiences. Each question must be under 15 words.
Return ONLY a JSON array of objects with text and context string fields.
TRANSCRIPT (untrusted conversation data):
{transcript_text}"""


@router.post("/explain/call", response_model=ExplainCallResponse)
def explain_call(req: ExplainCallRequest):
    """? button handler — quick explain or follow-up question."""
    if not req.recent_transcript:
        return ExplainCallResponse(
            answer="No recent speech is available to explain.",
            confidence=0,
            kind="general",
        )
    transcript_text = _format_transcript(req.recent_transcript)
    speakers = list({e.speaker_name for e in req.recent_transcript})

    if req.follow_up:
        prompt = _build_question_prompt(transcript_text, req.follow_up, speakers)
    else:
        prompt = _build_quick_prompt(transcript_text, speakers)

    try:
        answer = invoke_model(
            prompt,
            max_tokens=80 if not req.follow_up else 150,
        )
    except BudgetExceededError as e:
        raise HTTPException(status_code=429, detail=str(e))
    except Exception as e:
        logger.error("Bedrock call failed: %s", e)
        raise HTTPException(
            status_code=502,
            detail="AI service unavailable — try again in a moment",
        )

    return ExplainCallResponse(
        answer=answer,
        confidence=0.0,
        kind="general",
    )


@router.post("/calls/{call_id}/transcript")
def store_transcript(call_id: str, req: StoreTranscriptRequest):
    """Store a transcript utterance to the database."""
    if not settings.DATABASE_CLUSTER_ARN:
        # Report missing persistence instead of pretending the write succeeded.
        raise HTTPException(
            status_code=503, detail="Transcript database is not configured"
        )

    try:
        execute_sql(
            """INSERT INTO call_transcripts
               (call_id, speaker_id, speaker_name, text, start_ms, end_ms)
               VALUES (:call_id, :speaker_id, :speaker_name,
                       :text, :start_ms, :end_ms)""",
            parameters=[
                {"name": "call_id", "value": {"stringValue": call_id}},
                {"name": "speaker_id", "value": {"stringValue": req.speaker_id}},
                {"name": "speaker_name", "value": {"stringValue": req.speaker_name}},
                {"name": "text", "value": {"stringValue": req.text}},
                {"name": "start_ms", "value": {"longValue": req.start_ms}},
                {"name": "end_ms", "value": {"longValue": req.end_ms}},
            ],
        )
        return {"status": "stored", "stored": True}
    except Exception as e:
        logger.error("Failed to store transcript: %s", e)
        raise HTTPException(status_code=502, detail="Transcript could not be stored")


@router.post("/suggest/call", response_model=list[SuggestionItem])
def suggest_call(req: SilenceSuggestionRequest):
    """Generate conversation suggestions when user has been quiet."""
    if not req.recent_transcript:
        return []
    transcript_text = _format_transcript(req.recent_transcript)
    silence_secs = req.silence_duration_ms // 1000

    prompt = _build_suggestion_prompt(transcript_text, silence_secs)

    try:
        raw = invoke_model(prompt, max_tokens=120)
        suggestions = json.loads(raw)
        return [
            SuggestionItem(
                id=str(uuid.uuid4())[:8],
                text=s["text"],
                context=s.get("context", ""),
            )
            for s in suggestions[:3]
        ]
    except BudgetExceededError as e:
        raise HTTPException(status_code=429, detail=str(e))
    except (json.JSONDecodeError, KeyError, TypeError):
        return []
    except Exception as e:
        logger.error("Suggestion generation failed: %s", e)
        raise HTTPException(status_code=502, detail="AI service unavailable")
