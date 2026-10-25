"""Pydantic API schemas: one class per shape in docs/API.md, same field names."""

from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

UtcDatetime = Annotated[datetime, AfterValidator(lambda d: d.astimezone(UTC))]
GlossaryKind = Literal["nickname", "place", "event", "slang", "person", "inside_joke"]
GlossarySource = Literal["seed", "auto", "human"]
MessageKind = Literal["text", "system"]
CatchupSection = Literal["happened", "decisions", "open"]


class Schema(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class HealthResponse(Schema):
    status: Literal["ok"]


# Users, groups, messages


class User(Schema):
    id: str
    username: str
    display_name: str
    avatar_url: str | None = None
    phonetic_hint: str | None = None
    pronunciation_audio_url: str | None = None


class Reaction(Schema):
    emoji: str
    user_id: str


class Message(Schema):
    id: int
    group_id: int
    sender_id: str | None
    kind: MessageKind
    text: str
    ts: UtcDatetime
    reply_to: int | None
    reactions: list[Reaction] = []


class Member(Schema):
    user: User
    joined_at: UtcDatetime
    last_read_message_id: int | None
    is_newcomer: bool


class Group(Schema):
    id: int
    name: str
    avatar_url: str | None
    is_dm: bool
    member_count: int


class GroupDetail(Group):
    members: list[Member]


class InboxItem(Schema):
    group: Group
    last_message: Message | None
    unread_count: int
    last_read_message_id: int | None


class MessagePage(Schema):
    messages: list[Message]
    has_more_before: bool
    has_more_after: bool


class MessageCreate(Schema):
    sender_id: str
    text: str = Field(min_length=1, max_length=4000)
    reply_to: int | None = None


class ReactionToggle(Schema):
    user_id: str
    emoji: str = Field(min_length=1, max_length=32)


class ReadUpdate(Schema):
    user_id: str
    message_id: int


class GlossaryEntry(Schema):
    id: int
    group_id: int
    term: str
    aliases: list[str]
    meaning: str
    kind: GlossaryKind
    confidence: float
    source: GlossarySource
    first_seen_ts: UtcDatetime
    last_explained_ts: UtcDatetime | None
    source_message_ids: list[int]


# Realtime (WS frames are {"type": ..., "data": ...})


class WsEvent(Schema):
    type: Literal[
        "message.new",
        "reaction.updated",
        "read.updated",
        "ask.new",
        "ask.updated",
        "pong",
    ]
    data: dict[str, Any] | None = None


class ReactionUpdated(Schema):
    group_id: int
    message_id: int
    reactions: list[Reaction]


class ReadUpdated(Schema):
    group_id: int
    user_id: str
    message_id: int


# Feature 1: hold-to-explain

ExplainStatus = Literal["explained", "general", "plain", "unknown"]
ExplainKind = Literal[
    "nickname", "place", "event", "slang", "person", "inside_joke", "plain", "unknown"
]
AskStatus = Literal["pending", "answered", "declined"]


class ExplainRequest(Schema):
    group_id: int
    user_id: str
    message_id: int | None = None
    term: str | None = Field(default=None, max_length=200)
    explanation_id: int | None = None
    follow_up: str | None = Field(default=None, max_length=1000)


class MemberAsk(Schema):
    id: int
    group_id: int
    group_name: str
    term: str
    message: Message | None
    for_user: User
    asked_user: User
    status: AskStatus
    answer: str | None
    posted_message_id: int | None
    created_at: UtcDatetime
    answered_at: UtcDatetime | None


class HumanSource(Schema):
    ask_id: int
    user: User
    answer: str
    answered_at: UtcDatetime


class AskTarget(Schema):
    user: User
    existing: MemberAsk | None


class Explanation(Schema):
    explanation_id: int
    group_id: int
    message_id: int | None
    term: str | None
    status: ExplainStatus
    kind: ExplainKind
    meaning: str
    confidence: float
    follow_up: str | None
    sources: list[Message]
    human_sources: list[HumanSource]
    person: User | None
    ask: AskTarget | None


class AskCreate(Schema):
    group_id: int
    user_id: str
    term: str = Field(min_length=1, max_length=200)
    message_id: int | None = None


class AskAnswer(Schema):
    user_id: str
    answer: str | None = Field(default=None, max_length=1000)
    decline: bool = False
    post_in_chat: bool = False


class AskList(Schema):
    incoming: list[MemberAsk]
    outgoing: list[MemberAsk]


# Feature 2: pre-send clarity nudge


class Span(Schema):
    start: int
    end: int


class FlaggedTerm(Schema):
    term: str
    glossary_id: int
    matched_text: str
    start: int
    end: int
    meaning: str
    kind: GlossaryKind
    newcomer_ids: list[str]


class Newcomer(Schema):
    user_id: str
    display_name: str
    joined_at: UtcDatetime


class UnknownTerm(Schema):
    term: str
    start: int
    end: int


class NudgeCheck(Schema):
    show: bool
    flagged_terms: list[FlaggedTerm] = []
    newcomers: list[Newcomer] = []
    message: str | None = None


class NudgeUnknown(Schema):
    show: bool
    unknown_terms: list[UnknownTerm] = []
    newcomers: list[Newcomer] = []
    message: str | None = None


class NudgeCheckRequest(Schema):
    group_id: int
    user_id: str
    draft: str


class NudgeUnknownRequest(NudgeCheckRequest):
    pass


class NudgeRewriteRequest(NudgeCheckRequest):
    terms: list[str]


class NudgeRewriteResponse(Schema):
    rewritten: str
    changes: list[Span]


class NudgeAsideRequest(NudgeCheckRequest):
    term: str
    meaning: str


class NudgeAsideResponse(NudgeRewriteResponse):
    glossary_id: int


class NudgeDismissRequest(Schema):
    group_id: int
    user_id: str
    term: str


# Feature 3: catch-up


class CatchupPreview(Schema):
    unread_count: int
    since_message_id: int | None
    eligible: bool


class CatchupRequest(Schema):
    group_id: int
    user_id: str
    since_message_id: int | None = None


class CatchupAskRequest(CatchupRequest):
    question: str


class CatchupSource(Schema):
    start_message_id: int
    end_message_id: int


class CatchupAskResponse(Schema):
    answer: str
    sources: list[CatchupSource]


class CatchupBullet(Schema):
    section: CatchupSection
    text: str
    start_message_id: int
    end_message_id: int


class CatchupTerm(Schema):
    term: str
    glossary_id: int
    meaning: str


class CatchupResult(Schema):
    unread_count: int
    since_message_id: int
    until_message_id: int
    bullets: list[CatchupBullet]
    terms: list[CatchupTerm]


class CatchupMeta(Schema):
    """SSE `meta` event."""

    unread_count: int
    since_message_id: int
    until_message_id: int


class CatchupDone(Schema):
    """SSE `done` event."""

    elapsed_ms: int


class CatchupError(Schema):
    """SSE `error` event."""

    message: str


class ChunkDigestContent(Schema):
    """Suggested shape for `chunk_digests.digest` (internal, not in the contract)."""

    bullets: list[CatchupBullet] = []
    terms: list[str] = []
