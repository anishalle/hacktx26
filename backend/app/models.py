"""API schemas for request/response models."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: Literal["ok"]


# --- Call Transcript ---


class TranscriptEntry(BaseModel):
    speaker_id: str
    speaker_name: str
    text: str
    start_ms: int
    end_ms: int


class StoreTranscriptRequest(BaseModel):
    result_id: str | None = None
    speaker_id: str
    speaker_name: str
    text: str
    start_ms: int
    end_ms: int


# --- Explain Call (? button) ---


class ExplainCallRequest(BaseModel):
    call_id: UUID
    user_id: str
    at_ms: int | None = None
    follow_up: str | None = None
    recent_transcript: list[TranscriptEntry] = Field(default_factory=list)


class ExplainCallResponse(BaseModel):
    answer: str
    term: str | None = None
    status: str | None = None
    source: str | None = None
    source_result_ids: list[str] = Field(default_factory=list)
    confidence: float = 0.0
    kind: str | None = None  # inside_joke, slang, nickname, event, place, general


# --- Silence Suggestions ---


class SilenceSuggestionRequest(BaseModel):
    at_ms: int | None = None
    call_id: UUID
    user_id: str
    silence_duration_ms: int
    recent_transcript: list[TranscriptEntry] = Field(default_factory=list)


class SuggestionItem(BaseModel):
    id: str
    text: str
    context: str
