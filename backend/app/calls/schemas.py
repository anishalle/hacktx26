from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

Identifier = Annotated[str, Field(min_length=1, max_length=128)]
Millis = Annotated[int, Field(ge=0, le=9_007_199_254_740_991)]


class CreateCall(BaseModel):
    group_id: Identifier
    user_id: Identifier


class JoinCall(BaseModel):
    user_id: Identifier


class ChimeModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Attendee(ChimeModel):
    attendee_id: Identifier
    external_user_id: str = Field(default="", max_length=128)


class TranscriptItem(ChimeModel):
    start_time_ms: Millis
    end_time_ms: Millis
    content: str = Field(max_length=500)
    attendee: Attendee
    type: Literal["pronunciation", "punctuation"] = "pronunciation"


class Alternative(ChimeModel):
    transcript: str = Field(min_length=1, max_length=10_000)
    items: list[TranscriptItem] = Field(default_factory=list, max_length=2000)


class TranscriptResult(ChimeModel):
    result_id: Identifier
    is_partial: bool
    start_time_ms: Millis
    end_time_ms: Millis
    alternatives: list[Alternative] = Field(min_length=1, max_length=5)

    @model_validator(mode="after")
    def valid_time_range(self):
        if self.end_time_ms < self.start_time_ms:
            raise ValueError("endTimeMs must be at or after startTimeMs")
        for alternative in self.alternatives:
            for item in alternative.items:
                # Chime word end times are advisory; keep reversed ends as points.
                item.end_time_ms = max(item.start_time_ms, item.end_time_ms)
                # Preserve word times when Chime's segment bounds differ from them.
                self.start_time_ms = min(self.start_time_ms, item.start_time_ms)
                self.end_time_ms = max(self.end_time_ms, item.end_time_ms)
        return self


class TranscriptBatch(BaseModel):
    results: list[TranscriptResult] = Field(max_length=50)


class ExplainCall(BaseModel):
    at_ms: Millis
    follow_up: str | None = Field(default=None, min_length=1, max_length=1000)
    pending_results: list[TranscriptResult] = Field(default_factory=list, max_length=20)


class SuggestCall(BaseModel):
    at_ms: Millis
    silence_duration_ms: int = Field(ge=0, le=86_400_000)


class Explanation(BaseModel):
    answer: str = Field(min_length=1, max_length=500)
    status: Literal["explained", "unclear", "no_recent_speech"]
    source: Literal["conversation", "general_language", "unknown"]
    source_result_ids: list[str] = Field(default_factory=list, max_length=20)
