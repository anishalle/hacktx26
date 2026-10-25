from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

Kind = Literal["nickname", "place", "event", "slang", "person", "plain", "unknown"]


class Message(BaseModel):
    id: str
    group_id: str
    sender_id: str
    sender_name: str
    ts: datetime
    text: str


class Member(BaseModel):
    id: str
    name: str
    joined_at: datetime


class MessagePage(BaseModel):
    messages: list[Message]
    has_more: bool


class MessageCreate(BaseModel):
    text: str = Field(min_length=1, max_length=8000)

    @field_validator("text")
    @classmethod
    def nonempty(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Text cannot be blank")
        return value


class ExplainRequest(BaseModel):
    group_id: str
    message_id: str
    follow_up: str | None = Field(default=None, min_length=1, max_length=1000)
    explanation_id: str | None = None


class ModelAnswer(BaseModel):
    meaning: str = Field(min_length=1, max_length=3000)
    confidence: float = Field(ge=0, le=1)
    kind: Kind
    source_message_ids: list[str] = Field(default_factory=list, max_length=3)
    source_ask_ids: list[str] = Field(default_factory=list, max_length=3)


class HumanSource(BaseModel):
    id: str
    recipient_name: str
    answer: str
    answered_at: datetime


class Explanation(BaseModel):
    id: str
    message_id: str
    meaning: str
    confidence: float
    kind: Kind
    sources: list[Message] = Field(default_factory=list)
    human_sources: list[HumanSource] = Field(default_factory=list)
    can_ask_sender: bool
    sender_name: str


class AskCreate(BaseModel):
    group_id: str
    message_id: str
    question: str = Field(min_length=1, max_length=1000)

    @field_validator("question")
    @classmethod
    def nonempty(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Question cannot be blank")
        return value


class AskAnswer(BaseModel):
    answer: str | None = Field(default=None, min_length=1, max_length=2000)
    decline: bool = False

    @field_validator("answer")
    @classmethod
    def nonempty(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("Answer cannot be blank")
        return value.strip() if value else value


class MemberAsk(BaseModel):
    id: str
    group_id: str
    message_id: str
    message_text: str
    requester_id: str
    requester_name: str
    recipient_id: str
    recipient_name: str
    question: str
    answer: str | None
    status: Literal["pending", "answered", "declined"]
    created_at: datetime
    answered_at: datetime | None
