"""Pydantic API schemas: one class per shape in docs/API.md, same field names."""

from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from app.core.config import settings

UtcDatetime = Annotated[datetime, AfterValidator(lambda d: d.astimezone(UTC))]
GlossaryKind = Literal["nickname", "place", "event", "slang", "person", "inside_joke"]
GlossarySource = Literal["seed", "auto", "human"]
MessageKind = Literal["text", "system", "photo", "game"]
CatchupSection = Literal["happened", "decisions", "open"]


def media_url(name: str) -> str:
    return f"{settings.PUBLIC_URL.rstrip('/')}{settings.API_V1_STR}/media/{name}"


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
    about: str | None = None


class Reaction(Schema):
    emoji: str
    user_id: str


class Image(Schema):
    url: str
    width: int
    height: int


class Message(Schema):
    id: int
    group_id: int
    sender_id: str | None
    kind: MessageKind
    text: str
    ts: UtcDatetime
    reply_to: int | None
    reactions: list[Reaction] = []
    image: Image | None = None
    image_description: str | None = None
    game: "LoreGame | None" = None  # kind "game"; set by app/services/games.py

    @model_validator(mode="before")
    @classmethod
    def _image(cls, data: Any) -> Any:
        """ORM rows carry image_path/size; the API serves an absolute URL."""
        path = getattr(data, "image_path", None)
        if path and not isinstance(data, dict):
            return {
                **{
                    k: getattr(data, k)
                    for k in cls.model_fields
                    if k not in ("image", "game")
                },
                "image": Image(
                    url=media_url(path),
                    width=data.image_width or 0,
                    height=data.image_height or 0,
                ),
            }
        return data


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
        "call.updated",
        "call.caption",
        "lore.updated",
        "message.updated",
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

ExplainStatus = Literal["explained", "general", "plain", "unknown", "no_speech"]
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
    call_id: int | None = None
    said_by: User | None = None
    heard: str | None = None
    lore: list["Lore"] = []


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


# Feature 4: live ? on a group call

Millis = Annotated[int, Field(ge=0, le=9_007_199_254_740_991)]


class CallMember(Schema):
    user: User
    attendee_id: str
    joined_at: UtcDatetime
    left_at: UtcDatetime | None


class Call(Schema):
    id: int
    group_id: int
    started_by: str | None
    started_at: UtcDatetime
    ended_at: UtcDatetime | None
    members: list[CallMember]


class CallJoin(Schema):
    call: Call
    meeting: dict[str, Any]
    attendee: dict[str, Any]


class CallUserRequest(Schema):
    user_id: str


class CallCaption(Schema):
    call_id: int
    user_id: str
    turn_id: str
    text: str
    final: bool
    ts: UtcDatetime


class CallExplainRequest(Schema):
    user_id: str
    at_ms: Millis


# Feature 6: Lore

LoreStatus = Literal["suggested", "kept", "dismissed", "removed"]


class LoreCaption(Schema):
    user_id: str
    text: str
    start_ms: int
    end_ms: int


class LoreReplay(Schema):
    id: int
    call_id: int
    audio_url: str
    duration_ms: int
    started_at: UtcDatetime
    captions: list[LoreCaption]


class LoreTerm(Schema):
    term: str
    glossary_id: int | None


class LoreCover(Schema):
    photo: Message | None = None
    replay: LoreReplay | None = None


LoreEventKind = Literal["photo", "replay", "quote", "video"]  # video: reserved


class LoreSnippet(Schema):
    """Something a member actually sent or said around an event's anchor."""

    message_id: int | None  # null for spoken lines
    user: User | None
    text: str
    ts: UtcDatetime
    reactions: list[Reaction]
    reason: Literal["caption", "reply", "reaction", "key", "spoken", "after"]
    start_ms: int | None  # spoken lines: offset into the replay
    is_me: bool


class LoreEvent(Schema):
    kind: LoreEventKind
    at: UtcDatetime
    message: Message | None  # photo / quote anchor
    replay: LoreReplay | None
    snippets: list[LoreSnippet]


class Lore(Schema):
    id: int
    group_id: int
    group_name: str
    title: str
    status: LoreStatus
    source: Literal["chat", "call"]
    call_id: int | None
    started_at: UtcDatetime
    ended_at: UtcDatetime
    people: list[User]
    terms: list[LoreTerm]
    hero_kind: LoreEventKind
    events: list[LoreEvent]  # events[0] is the hero, the rest oldest first
    media: list[Message]  # photo messages, oldest first
    cover: LoreCover  # from events[0]
    anchor_message_id: int | None
    message_count: int
    photo_count: int
    replay_count: int
    kept_by: User | None
    kept_at: UtcDatetime | None
    pinned: bool  # by the requesting member


class LoreDetail(Lore):
    messages: list[Message]
    photos: list[Message]
    replays: list[LoreReplay]
    related: list[Lore]


class LoreCounts(Schema):
    photo: int
    replay: int
    quote: int
    pinned: int


class LoreFeed(Schema):
    items: list[Lore]
    next_cursor: str | None
    counts: LoreCounts


class LoreAction(Schema):
    user_id: str


# Feature 7: Guess that Lore

GameStatus = Literal["open", "revealed"]


class LoreGameOption(Schema):
    user: User
    votes: int  # always counted; who voted for it shows after the reveal
    voters: list[User]  # empty until revealed


class LoreGame(Schema):
    id: int
    group_id: int
    message_id: int
    lore_id: int
    started_by: str | None
    prompt: str
    question: str
    hints: list[str]  # only the unlocked ones
    hints_total: int
    options: list[LoreGameOption]
    my_vote: str | None  # the viewer's pick (a user id)
    total_votes: int
    member_count: int
    can_reveal: bool  # for the viewer
    status: GameStatus
    answer: User | None  # revealed only
    lore_title: str | None  # revealed only
    created_at: UtcDatetime
    revealed_at: UtcDatetime | None


class GameStart(Schema):
    user_id: str


class GameVote(Schema):
    user_id: str
    choice: str


Explanation.model_rebuild()
Message.model_rebuild()
