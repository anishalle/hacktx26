"""API schemas for request/response models."""

from typing import Literal

from pydantic import BaseModel


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
    speaker_id: str
    speaker_name: str
    text: str
    start_ms: int
    end_ms: int


# --- Explain Call (? button) ---

class ExplainCallRequest(BaseModel):
    call_id: str
    user_id: str
    at_ms: int | None = None
    follow_up: str | None = None
    recent_transcript: list[TranscriptEntry] = []


class ExplainCallResponse(BaseModel):
    answer: str
    term: str | None = None
    confidence: float = 0.8
    kind: str | None = None  # inside_joke, slang, nickname, event, place, general


# --- Silence Suggestions ---

class SilenceSuggestionRequest(BaseModel):
    call_id: str
    user_id: str
    silence_duration_ms: int
    recent_transcript: list[TranscriptEntry] = []


class SuggestionItem(BaseModel):
    id: str
    text: str
    context: str
