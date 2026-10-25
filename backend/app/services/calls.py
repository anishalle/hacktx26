"""Feature 4: group calls on Amazon Chime, stored transcripts, and the ? button.

The server only does Chime's control plane: it creates the meeting (with live
transcription) and one attendee per member, and deletes the meeting when the last
member leaves. Audio, video and transcript events travel between Chime and the iOS
bridge; every client forwards final results to `ingest`, deduplicated by result id.
Attendees use our user id as Chime's ExternalUserId, so transcript lines map to
members.

The ? button clips the transcript at the tap (word timestamps, so a sentence that
crosses the cutoff keeps only the words before it) and runs the feature 1 pipeline
with the call as the subject.

Test seam: `set_chime(fake)` / `set_chime(None)`; `FakeChime` records calls (the
autouse `fake_chime` pytest fixture installs one).
"""

import asyncio
import logging
import time
import uuid
from datetime import UTC, datetime
from typing import Any, Protocol

from fastapi import HTTPException
from sqlalchemy import and_, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.core.config import settings
from app.models import Call, CallMember, CallTranscript, Explanation, User
from app.services import explain
from app.services.messages import require_group, require_member
from app.services.realtime import broadcast_group

log = logging.getLogger(__name__)

FOCUS_MS = 45_000  # "the last ~45 seconds of transcript"
BACKGROUND_MS = 120_000  # "plus the last 2 minutes as background"
CLOCK_SKEW_MS = 5_000
NO_SPEECH = "I didn't catch anything in the last 45 seconds."


# -------------------------------------------------------------------- Chime


class Chime(Protocol):
    async def create_meeting(self, token: str) -> dict[str, Any]: ...
    async def create_attendee(
        self, meeting_id: str, user_id: str
    ) -> dict[str, Any]: ...
    async def start_transcription(self, meeting_id: str) -> None: ...
    async def delete_attendee(self, meeting_id: str, attendee_id: str) -> None: ...
    async def delete_meeting(self, meeting_id: str) -> None: ...


class MeetingGone(Exception):
    pass


class AwsChime:
    def __init__(self) -> None:
        self._client: Any = None

    @property
    def client(self) -> Any:
        if self._client is None:
            import boto3
            from botocore.config import Config

            self._client = boto3.client(
                "chime-sdk-meetings",
                region_name=settings.AWS_REGION,
                config=Config(connect_timeout=3, read_timeout=10),
            )
        return self._client

    async def _run(self, name: str, **kwargs: Any) -> dict[str, Any]:
        try:
            return await asyncio.to_thread(getattr(self.client, name), **kwargs)
        except self.client.exceptions.NotFoundException as exc:
            raise MeetingGone(name) from exc

    async def create_meeting(self, token: str) -> dict[str, Any]:
        resp = await self._run(
            "create_meeting",
            ClientRequestToken=token,
            MediaRegion=settings.AWS_REGION,
            ExternalMeetingId=f"hacktx26-{token}",
        )
        return resp["Meeting"]

    async def create_attendee(self, meeting_id: str, user_id: str) -> dict[str, Any]:
        resp = await self._run(
            "create_attendee", MeetingId=meeting_id, ExternalUserId=user_id
        )
        return resp["Attendee"]

    async def start_transcription(self, meeting_id: str) -> None:
        await self._run(
            "start_meeting_transcription",
            MeetingId=meeting_id,
            TranscriptionConfiguration={
                "EngineTranscribeSettings": {
                    "LanguageCode": "en-US",
                    "Region": settings.AWS_REGION,
                    "EnablePartialResultsStabilization": True,
                    "PartialResultsStability": "medium",
                }
            },
        )

    async def delete_attendee(self, meeting_id: str, attendee_id: str) -> None:
        await self._run("delete_attendee", MeetingId=meeting_id, AttendeeId=attendee_id)

    async def delete_meeting(self, meeting_id: str) -> None:
        await self._run("delete_meeting", MeetingId=meeting_id)


class FakeChime:
    def __init__(self) -> None:
        self.meetings: dict[str, dict[str, Any]] = {}
        self.transcribing: set[str] = set()
        self.deleted: list[str] = []

    async def create_meeting(self, token: str) -> dict[str, Any]:
        mid = f"m-{token[:8]}"
        self.meetings[mid] = {"MeetingId": mid, "MediaRegion": "us-east-1"}
        return dict(self.meetings[mid], MediaPlacement={"AudioHostUrl": "fake"})

    async def create_attendee(self, meeting_id: str, user_id: str) -> dict[str, Any]:
        if meeting_id not in self.meetings:
            raise MeetingGone(meeting_id)
        aid = f"a-{meeting_id}-{user_id}"
        return {"AttendeeId": aid, "ExternalUserId": user_id, "JoinToken": "t"}

    async def start_transcription(self, meeting_id: str) -> None:
        self.transcribing.add(meeting_id)

    async def delete_attendee(self, meeting_id: str, attendee_id: str) -> None:
        pass

    async def delete_meeting(self, meeting_id: str) -> None:
        self.deleted.append(meeting_id)
        if self.meetings.pop(meeting_id, None) is None:
            raise MeetingGone(meeting_id)


_chime: Chime = AwsChime()


def set_chime(chime: Chime | None) -> None:
    """Install a Chime client (tests); None restores AWS."""
    global _chime
    _chime = chime if chime is not None else AwsChime()


async def _chime_call[T](coro: Any) -> T:
    try:
        return await coro
    except MeetingGone:
        raise
    except Exception as exc:
        log.warning("Chime request failed: %r", exc)
        raise HTTPException(502, "Couldn't reach the call service. Try again.") from exc


# -------------------------------------------------------------------- calls


async def _view(session: AsyncSession, call: Call) -> schemas.Call:
    await session.refresh(call, ["members"])
    return schemas.Call.model_validate(call)


async def _active(session: AsyncSession, group_id: int) -> Call | None:
    return await session.scalar(
        select(Call).where(Call.group_id == group_id, Call.ended_at.is_(None))
    )


async def _require_call(session: AsyncSession, call_id: int, user_id: str) -> Call:
    call = await session.get(Call, call_id)
    if call is None:
        raise HTTPException(404, "Call not found")
    await require_member(session, call.group_id, user_id)
    return call


async def get_call(session: AsyncSession, group_id: int) -> schemas.Call | None:
    await require_group(session, group_id)
    call = await _active(session, group_id)
    return await _view(session, call) if call else None


async def _end(session: AsyncSession, call: Call) -> None:
    call.ended_at = datetime.now(UTC)
    for m in call.members:
        m.left_at = m.left_at or call.ended_at
    try:
        await _chime.delete_meeting(call.meeting_id)
    except MeetingGone:
        pass
    except Exception:
        log.exception("couldn't delete Chime meeting %s", call.meeting_id)


_join_locks: dict[int, asyncio.Lock] = {}


async def join(session: AsyncSession, group_id: int, user_id: str) -> schemas.CallJoin:
    """Start the group's call (with transcription) or join the active one."""
    await require_member(session, group_id, user_id)
    async with _join_locks.setdefault(group_id, asyncio.Lock()):
        call = await _active(session, group_id)
        attendee = None
        if call is not None:
            try:
                attendee = await _chime_call(
                    _chime.create_attendee(call.meeting_id, user_id)
                )
            except MeetingGone:  # Chime ends empty meetings on its own
                await _end(session, call)
                await session.commit()
                call = None
        if call is None:
            token = str(uuid.uuid4())
            meeting = await _chime_call(_chime.create_meeting(token))
            call = Call(
                group_id=group_id,
                meeting_id=meeting["MeetingId"],
                meeting=meeting,
                started_by=user_id,
            )
            session.add(call)
            await session.flush()
            attendee = await _chime_call(
                _chime.create_attendee(call.meeting_id, user_id)
            )
            try:
                await _chime.start_transcription(call.meeting_id)
            except Exception:
                log.exception("couldn't start transcription for call %s", call.id)
        assert attendee is not None
        member = await session.get(CallMember, (call.id, user_id))
        if member is None:
            session.add(
                CallMember(
                    call_id=call.id,
                    user_id=user_id,
                    attendee_id=attendee["AttendeeId"],
                )
            )
        else:
            member.attendee_id = attendee["AttendeeId"]
            member.joined_at, member.left_at = datetime.now(UTC), None
        await session.commit()
    view = await _view(session, call)
    await broadcast_group(session, group_id, "call.updated", view)
    return schemas.CallJoin(call=view, meeting=call.meeting, attendee=attendee)


async def leave(session: AsyncSession, call_id: int, user_id: str) -> schemas.Call:
    """Leave the call; the last member out ends it for everyone."""
    call = await _require_call(session, call_id, user_id)
    member = await session.get(CallMember, (call_id, user_id))
    if call.ended_at is None and member is not None and member.left_at is None:
        member.left_at = datetime.now(UTC)
        await session.refresh(call, ["members"])
        if all(m.left_at for m in call.members):
            await _end(session, call)
        else:
            try:
                await _chime.delete_attendee(call.meeting_id, member.attendee_id)
            except Exception:
                log.info("attendee %s already gone", member.attendee_id)
        await session.commit()
    view = await _view(session, call)
    await broadcast_group(session, call.group_id, "call.updated", view)
    return view


# --------------------------------------------------------------- transcripts


def _speaker(result: schemas.ChimeResult, members: set[str]) -> str | None:
    for item in result.alternatives[0].items:
        if item.attendee.external_user_id in members:
            return item.attendee.external_user_id
    return None


async def _store(
    session: AsyncSession, call: Call, results: list[schemas.ChimeResult]
) -> int:
    started_ms = int(call.started_at.timestamp() * 1000)
    now_ms = int(time.time() * 1000)
    for r in results:
        if r.start_time_ms < started_ms - CLOCK_SKEW_MS:
            raise HTTPException(422, "Transcript times must be epoch milliseconds")
        if r.end_time_ms > now_ms + CLOCK_SKEW_MS:
            raise HTTPException(422, "Transcript time is in the future")
    members = set(await crud.member_ids(session, call.group_id))
    stored = 0
    for r in results:
        alt = r.alternatives[0]
        if not alt.transcript.strip():
            continue
        stmt = pg_insert(CallTranscript).values(
            call_id=call.id,
            result_id=r.result_id,
            speaker_id=_speaker(r, members),
            start_ms=r.start_time_ms,
            end_ms=r.end_time_ms,
            text=alt.transcript,
            items=[i.model_dump(by_alias=True) for i in alt.items],
            is_partial=r.is_partial,
        )
        ex = stmt.excluded
        # Only a stored partial can change: to a final, or to a longer partial.
        await session.execute(
            stmt.on_conflict_do_update(
                index_elements=["call_id", "result_id"],
                set_={
                    "speaker_id": ex.speaker_id,
                    "start_ms": ex.start_ms,
                    "end_ms": ex.end_ms,
                    "text": ex.text,
                    "items": ex["items"],
                    "is_partial": ex.is_partial,
                    "received_at": datetime.now(UTC),
                },
                where=and_(
                    CallTranscript.is_partial,
                    or_(~ex.is_partial, ex.end_ms >= CallTranscript.end_ms),
                ),
            )
        )
        stored += 1
    return stored


async def ingest(
    session: AsyncSession, call_id: int, body: schemas.TranscriptBatch
) -> schemas.TranscriptStored:
    """Store final results; partials are only for on-screen captions."""
    call = await _require_call(session, call_id, body.user_id)
    if call.ended_at is not None:
        raise HTTPException(409, "This call has ended")
    finals = [r for r in body.results if not r.is_partial]
    stored = await _store(session, call, finals)
    await session.commit()
    return schemas.TranscriptStored(stored=stored)


def clip(rows: list[CallTranscript], start_ms: int, end_ms: int) -> list[tuple]:
    """(speaker_id, text) lines said within [start_ms, end_ms], oldest first. Results
    with word timestamps keep only the words inside the window."""
    out: list[tuple[str | None, str]] = []
    for row in rows:
        if not row.items:
            if row.start_ms >= start_ms and row.end_ms <= end_ms:
                out.append((row.speaker_id, row.text))
            continue
        words = ""
        for item in row.items:
            if item["startTimeMs"] > end_ms or item["endTimeMs"] < start_ms:
                continue
            sep = "" if item.get("type") == "punctuation" or not words else " "
            words += sep + item["content"]
        if words.strip():
            out.append((row.speaker_id, words.strip()))
    return out


async def explain_call(
    session: AsyncSession, call_id: int, body: schemas.CallExplainRequest
) -> schemas.Explanation:
    """The ? button: explain what was just said, with the group's chat history."""
    call = await _require_call(session, call_id, body.user_id)
    membership = await require_member(session, call.group_id, body.user_id)
    if body.at_ms > int(time.time() * 1000) + CLOCK_SKEW_MS:
        raise HTTPException(422, "at_ms is in the future")
    if body.pending_results:
        if call.ended_at is not None:
            raise HTTPException(409, "This call has ended")
        await _store(session, call, body.pending_results)
        await session.commit()

    since = body.at_ms - FOCUS_MS - BACKGROUND_MS
    rows = list(
        await session.scalars(
            select(CallTranscript)
            .where(
                CallTranscript.call_id == call_id,
                CallTranscript.end_ms >= since,
                CallTranscript.start_ms <= body.at_ms,
            )
            .order_by(CallTranscript.start_ms, CallTranscript.result_id)
        )
    )
    focus = clip(rows, body.at_ms - FOCUS_MS, body.at_ms)
    background = clip(rows, since, body.at_ms - FOCUS_MS - 1)
    if not focus:
        row = Explanation(
            group_id=call.group_id,
            user_id=body.user_id,
            message_id=None,
            answer={"context": None, "answer": {"status": "no_speech"}},
        )
        session.add(row)
        await session.commit()
        return schemas.Explanation(
            explanation_id=row.id,
            group_id=call.group_id,
            message_id=None,
            term=None,
            status="no_speech",
            kind="unknown",
            meaning=NO_SPEECH,
            confidence=0,
            follow_up=None,
            sources=[],
            human_sources=[],
            person=None,
            ask=None,
            call_id=call.id,
        )

    names = {
        u.id: u.display_name
        for u in await session.scalars(
            select(User).where(User.id.in_({s for s, _ in focus + background if s}))
        )
    }

    def lines(part: list[tuple]) -> list[explain.CallLine]:
        return [explain.CallLine(s, names.get(s, "Someone"), t) for s, t in part]

    focus_obj = explain.CallFocus(call.id, lines(focus), lines(background))
    ctx = await explain.build_context(session, membership, None, None, call=focus_obj)
    return await explain.answer(session, ctx)
