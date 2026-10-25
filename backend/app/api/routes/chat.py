import logging
from typing import Annotated
from uuid import uuid4

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, HTTPException, Query

from app import repository
from app.api.deps import current_user
from app.chat_models import (
    AskAnswer,
    AskCreate,
    ExplainRequest,
    Explanation,
    Member,
    MemberAsk,
    Message,
    MessageCreate,
    MessagePage,
)
from app.core.db import get_db
from app.explanations import explain_message

router = APIRouter(tags=["chat"])
Database = Annotated[object, Depends(get_db)]
User = Annotated[str, Depends(current_user)]
logger = logging.getLogger(__name__)


@router.get("/groups/{group_id}/members", response_model=list[Member])
def members(group_id: str, db: Database, user: User):
    repository.require_membership(db, group_id, user)
    return repository.members(db, group_id)


@router.get("/groups/{group_id}/messages", response_model=MessagePage)
def messages(
    group_id: str,
    db: Database,
    user: User,
    limit: int = Query(default=50, ge=1, le=100),
    before: str | None = None,
    around: str | None = None,
):
    repository.require_membership(db, group_id, user)
    return repository.page(db, group_id, limit, before, around)


@router.post("/groups/{group_id}/messages", response_model=Message, status_code=201)
def send_message(group_id: str, body: MessageCreate, db: Database, user: User):
    repository.require_membership(db, group_id, user)
    message_id = str(uuid4())
    db.execute(
        """INSERT INTO messages (id, group_id, sender_id, ts, text)
        VALUES (%s, %s, %s, now(), %s)""",
        (message_id, group_id, user, body.text),
    )
    # New messages remain searchable through full text immediately. The resumable
    # indexing command embeds them; a Bedrock outage never blocks sending a message.
    return repository.message(db, group_id, message_id)


@router.post("/explain/message", response_model=Explanation)
def explain(body: ExplainRequest, db: Database, user: User):
    try:
        return explain_message(db, body, user)
    except (BotoCoreError, ClientError) as exc:
        logger.warning("Bedrock request failed (%s)", type(exc).__name__)
        raise HTTPException(
            503, "AI service unavailable. Check the AWS session and model access."
        ) from exc


@router.get("/groups/{group_id}/member-asks", response_model=list[MemberAsk])
def asks(group_id: str, db: Database, user: User):
    repository.require_membership(db, group_id, user)
    return repository.list_asks(db, group_id, user)


@router.post("/ask-member", response_model=MemberAsk, status_code=201)
def ask(body: AskCreate, db: Database, user: User):
    # The tap on this endpoint is the newcomer's explicit opt-in. No automatic asks.
    repository.require_membership(db, body.group_id, user)
    return repository.create_ask(
        db, body.group_id, body.message_id, user, body.question
    )


@router.post("/ask-member/{ask_id}/answer", response_model=MemberAsk)
def answer(ask_id: str, body: AskAnswer, db: Database, user: User):
    return repository.answer_ask(db, ask_id, user, body.answer, body.decline)
