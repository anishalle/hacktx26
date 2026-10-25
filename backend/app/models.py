"""SQLAlchemy table models, mirroring the "Data model" section of docs/API.md."""

from datetime import datetime
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Computed,
    DateTime,
    Float,
    ForeignKey,
    Identity,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, TSVECTOR
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from app.core.config import settings


class Base(DeclarativeBase):
    type_annotation_map = {datetime: DateTime(timezone=True)}


def _group_fk() -> Any:
    return ForeignKey("groups.id", ondelete="CASCADE")


def _user_fk() -> Any:
    return ForeignKey("users.id", ondelete="CASCADE")


def _now() -> Any:
    return mapped_column(server_default=func.now())


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    display_name: Mapped[str] = mapped_column(String(128))
    avatar_url: Mapped[str | None] = mapped_column(Text)
    phonetic_hint: Mapped[str | None] = mapped_column(Text)
    pronunciation_audio_url: Mapped[str | None] = mapped_column(Text)


class Group(Base):
    __tablename__ = "groups"

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    avatar_url: Mapped[str | None] = mapped_column(Text)
    is_dm: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = _now()

    memberships: Mapped[list["Membership"]] = relationship(
        back_populates="group", order_by="Membership.joined_at"
    )


class Membership(Base):
    __tablename__ = "memberships"

    group_id: Mapped[int] = mapped_column(_group_fk(), primary_key=True)
    user_id: Mapped[str] = mapped_column(_user_fk(), primary_key=True, index=True)
    joined_at: Mapped[datetime] = _now()
    last_read_message_id: Mapped[int | None] = mapped_column(BigInteger)

    group: Mapped[Group] = relationship(back_populates="memberships")
    user: Mapped[User] = relationship(lazy="joined")


# Search covers a photo's description too (the migration in app/core/db.py matches).
TSV_EXPRESSION = (
    "to_tsvector('english', text || ' ' || coalesce(image_description, ''))"
)


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        Index("ix_messages_group_id_id", "group_id", "id"),
        Index("ix_messages_tsv", "tsv", postgresql_using="gin"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    group_id: Mapped[int] = mapped_column(_group_fk())
    sender_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    kind: Mapped[str] = mapped_column(String(16), default="text")  # text|system|photo
    text: Mapped[str] = mapped_column(Text)  # a photo's caption ("" if none)
    ts: Mapped[datetime] = _now()
    reply_to: Mapped[int | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL")
    )
    image_path: Mapped[str | None] = mapped_column(Text)  # file name in MEDIA_DIR
    image_width: Mapped[int | None]
    image_height: Mapped[int | None]
    image_description: Mapped[str | None] = mapped_column(Text)  # Muse, after upload
    tsv: Mapped[Any] = mapped_column(
        TSVECTOR,
        Computed(TSV_EXPRESSION, persisted=True),
    )

    reactions: Mapped[list["Reaction"]] = relationship(
        order_by="Reaction.created_at", cascade="all, delete-orphan", lazy="selectin"
    )


class Reaction(Base):
    __tablename__ = "reactions"

    message_id: Mapped[int] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(_user_fk(), primary_key=True)
    emoji: Mapped[str] = mapped_column(String(32), primary_key=True)
    created_at: Mapped[datetime] = _now()


class MessageWindow(Base):
    __tablename__ = "message_windows"
    __table_args__ = (UniqueConstraint("group_id", "start_message_id"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    group_id: Mapped[int] = mapped_column(_group_fk(), index=True)
    start_message_id: Mapped[int] = mapped_column(BigInteger)
    end_message_id: Mapped[int] = mapped_column(BigInteger)
    text: Mapped[str] = mapped_column(Text)
    embedding: Mapped[Any | None] = mapped_column(Vector(settings.EMBEDDING_DIM))


class Glossary(Base):
    __tablename__ = "glossary"
    __table_args__ = (
        Index("uq_glossary_group_term", "group_id", text("lower(term)"), unique=True),
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    group_id: Mapped[int] = mapped_column(_group_fk())
    term: Mapped[str] = mapped_column(Text)
    aliases: Mapped[list[str]] = mapped_column(
        ARRAY(Text), default=list, server_default="{}"
    )
    meaning: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(32))
    confidence: Mapped[float] = mapped_column(Float, default=1.0)
    source: Mapped[str] = mapped_column(
        String(16), default="auto"
    )  # seed | auto | human
    first_seen_ts: Mapped[datetime] = _now()
    last_explained_ts: Mapped[datetime | None]
    source_message_ids: Mapped[list[int]] = mapped_column(
        ARRAY(BigInteger), default=list, server_default="{}"
    )


class NudgeDismissal(Base):
    __tablename__ = "nudge_dismissals"

    user_id: Mapped[str] = mapped_column(_user_fk(), primary_key=True)
    group_id: Mapped[int] = mapped_column(_group_fk(), primary_key=True)
    term: Mapped[str] = mapped_column(Text, primary_key=True)
    created_at: Mapped[datetime] = _now()


class ChunkDigest(Base):
    __tablename__ = "chunk_digests"
    __table_args__ = (UniqueConstraint("group_id", "start_message_id"),)

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    group_id: Mapped[int] = mapped_column(_group_fk())
    start_message_id: Mapped[int] = mapped_column(BigInteger)
    end_message_id: Mapped[int] = mapped_column(BigInteger)
    start_ts: Mapped[datetime]
    end_ts: Mapped[datetime]
    message_count: Mapped[int]
    digest: Mapped[dict[str, Any]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = _now()


class Explanation(Base):
    __tablename__ = "explanations"

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    group_id: Mapped[int] = mapped_column(_group_fk(), index=True)
    user_id: Mapped[str] = mapped_column(_user_fk())
    message_id: Mapped[int | None] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE")
    )  # null when a bare term was explained (catch-up term chips)
    answer: Mapped[dict[str, Any]] = mapped_column(JSONB)  # answer + context snapshot
    created_at: Mapped[datetime] = _now()


class MemberAsk(Base):
    __tablename__ = "member_asks"

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    group_id: Mapped[int] = mapped_column(_group_fk(), index=True)
    asked_user_id: Mapped[str] = mapped_column(_user_fk())
    for_user_id: Mapped[str] = mapped_column(_user_fk())
    term: Mapped[str] = mapped_column(Text)
    message_id: Mapped[int | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(
        String(16), default="pending"
    )  # pending|answered|declined
    answer: Mapped[str | None] = mapped_column(Text)
    posted_message_id: Mapped[int | None] = mapped_column(
        ForeignKey("messages.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = _now()
    answered_at: Mapped[datetime | None]


class Call(Base):
    """Feature 4: a group call on Amazon Chime; at most one active per group."""

    __tablename__ = "calls"
    __table_args__ = (
        Index(
            "uq_calls_active_group",
            "group_id",
            unique=True,
            postgresql_where=text("ended_at IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    group_id: Mapped[int] = mapped_column(_group_fk())
    meeting_id: Mapped[str] = mapped_column(String(64), unique=True)
    meeting: Mapped[dict[str, Any]] = mapped_column(JSONB)  # Chime "Meeting" object
    started_by: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    started_at: Mapped[datetime] = _now()
    ended_at: Mapped[datetime | None]

    members: Mapped[list["CallMember"]] = relationship(
        order_by="CallMember.joined_at", lazy="selectin"
    )


class CallMember(Base):
    __tablename__ = "call_members"

    call_id: Mapped[int] = mapped_column(
        ForeignKey("calls.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(_user_fk(), primary_key=True)
    attendee_id: Mapped[str] = mapped_column(String(64))
    joined_at: Mapped[datetime] = _now()
    left_at: Mapped[datetime | None]

    user: Mapped[User] = relationship(lazy="joined")


class CallTranscript(Base):
    """One Chime transcript result; `(call_id, result_id)` dedupes every client's
    copy, and a final is never overwritten by a late partial."""

    __tablename__ = "call_transcripts"
    __table_args__ = (Index("ix_call_transcripts_time", "call_id", "start_ms"),)

    call_id: Mapped[int] = mapped_column(
        ForeignKey("calls.id", ondelete="CASCADE"), primary_key=True
    )
    result_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    speaker_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    start_ms: Mapped[int] = mapped_column(BigInteger)  # epoch ms
    end_ms: Mapped[int] = mapped_column(BigInteger)
    text: Mapped[str] = mapped_column(Text)
    items: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    is_partial: Mapped[bool]
    received_at: Mapped[datetime] = _now()


class LoreReplay(Base):
    """Feature 6: a saved call moment, the mixed audio (WAV in MEDIA_DIR) and the
    caption timeline, with offsets in ms from the clip start."""

    __tablename__ = "lore_replays"

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    call_id: Mapped[int] = mapped_column(ForeignKey("calls.id", ondelete="CASCADE"))
    group_id: Mapped[int] = mapped_column(_group_fk(), index=True)
    audio_path: Mapped[str] = mapped_column(Text)
    duration_ms: Mapped[int]
    started_at: Mapped[datetime]
    captions: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    signal: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = _now()


class Lore(Base):
    """Feature 6: a group's moment (suggested, kept, dismissed or removed)."""

    __tablename__ = "lore"
    __table_args__ = (Index("ix_lore_group_status", "group_id", "status"),)

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    group_id: Mapped[int] = mapped_column(_group_fk())
    title: Mapped[str] = mapped_column(Text)
    story: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="suggested")
    source: Mapped[str] = mapped_column(String(8), default="chat")  # chat|call
    call_id: Mapped[int | None] = mapped_column(
        ForeignKey("calls.id", ondelete="SET NULL")
    )
    started_at: Mapped[datetime]
    ended_at: Mapped[datetime]
    people: Mapped[list[str]] = mapped_column(
        ARRAY(Text), default=list, server_default="{}"
    )
    terms: Mapped[list[str]] = mapped_column(
        ARRAY(Text), default=list, server_default="{}"
    )
    message_ids: Mapped[list[int]] = mapped_column(
        ARRAY(BigInteger), default=list, server_default="{}"
    )
    replay_ids: Mapped[list[int]] = mapped_column(
        ARRAY(Integer), default=list, server_default="{}"
    )
    anchor_message_id: Mapped[int | None] = mapped_column(BigInteger)
    # What the moment shows, oldest first (app/services/lore.py `_events`); null
    # until computed. The hero is this photo (or the quote's message) when set.
    events: Mapped[list[dict[str, Any]] | None] = mapped_column(
        JSONB(none_as_null=True)
    )
    hero_message_id: Mapped[int | None] = mapped_column(BigInteger)
    score: Mapped[float] = mapped_column(Float, default=0.0)
    embedding: Mapped[Any | None] = mapped_column(Vector(settings.EMBEDDING_DIM))
    kept_by: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    kept_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = _now()


class LorePin(Base):
    """Feature 6: a member's pinned lore (keeping it is group-wide, pinning is not)."""

    __tablename__ = "lore_pins"

    user_id: Mapped[str] = mapped_column(_user_fk(), primary_key=True)
    lore_id: Mapped[int] = mapped_column(
        ForeignKey("lore.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    pinned_at: Mapped[datetime] = _now()
