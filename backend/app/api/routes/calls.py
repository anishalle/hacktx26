import hmac
import logging
import time
from functools import lru_cache
from typing import Annotated
from uuid import UUID

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, Header, HTTPException, Query

from app.calls.schemas import (
    CreateCall,
    ExplainCall,
    Explanation,
    JoinCall,
    TranscriptBatch,
)
from app.calls.service import CallService
from app.core.config import settings

router = APIRouter(prefix="/calls", tags=["calls"])
logger = logging.getLogger(__name__)


@lru_cache
def get_call_service():
    if not settings.DATABASE_CLUSTER_ARN or not settings.DATABASE_SECRET_ARN:
        raise HTTPException(503, "Call database is not configured")
    return CallService(settings)


def require_demo_key(x_demo_key: Annotated[str, Header()] = ""):
    if not settings.CALLS_DEMO_API_KEY:
        raise HTTPException(503, "Call demo access is not configured")
    if not hmac.compare_digest(
        x_demo_key.encode(), settings.CALLS_DEMO_API_KEY.encode()
    ):
        raise HTTPException(401, "Invalid X-Demo-Key")


def aws_operation(operation):
    try:
        return operation()
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "Unknown")
        logger.error("Call AWS operation failed: %s", code)
        if code in ("NotFoundException", "ResourceNotFoundException"):
            raise HTTPException(
                410, "The call resource is no longer available"
            ) from None
        if code in ("ThrottlingException", "TooManyRequestsException"):
            raise HTTPException(503, "Call service is busy; try again") from None
        raise HTTPException(502, "Call service operation failed") from None
    except BotoCoreError:
        logger.error("Call AWS transport operation failed")
        raise HTTPException(502, "Call service is temporarily unavailable") from None


Service = Annotated[CallService, Depends(get_call_service)]
CallToken = Annotated[str, Header(alias="X-Call-Token", max_length=256)]


@router.post("", status_code=201, dependencies=[Depends(require_demo_key)])
def create_call(body: CreateCall, service: Service):
    return aws_operation(lambda: service.create(body.group_id, body.user_id))


@router.post("/{call_id}/join", dependencies=[Depends(require_demo_key)])
def join_call(call_id: UUID, body: JoinCall, service: Service):
    return aws_operation(lambda: service.join(str(call_id), body.user_id))


@router.post("/{call_id}/transcription/start")
def start_transcription(call_id: UUID, service: Service, x_call_token: CallToken = ""):
    return aws_operation(
        lambda: service.start_transcription(str(call_id), x_call_token)
    )


@router.post("/{call_id}/transcripts")
def ingest_transcripts(
    call_id: UUID,
    body: TranscriptBatch,
    service: Service,
    x_call_token: CallToken = "",
):
    return aws_operation(
        lambda: service.ingest(str(call_id), x_call_token, body.results)
    )


@router.get("/{call_id}/transcripts")
def get_transcripts(
    call_id: UUID,
    service: Service,
    x_call_token: CallToken = "",
    since_ms: Annotated[int, Query(ge=0)] = 0,
    at_ms: Annotated[int | None, Query(ge=0)] = None,
):
    at = at_ms if at_ms is not None else int(time.time() * 1000)
    if since_ms > at:
        raise HTTPException(422, "since_ms must be at or before at_ms")
    return aws_operation(
        lambda: service.transcripts(str(call_id), x_call_token, since_ms, at),
    )


@router.post("/{call_id}/explain", response_model=Explanation)
def explain_call(
    call_id: UUID,
    body: ExplainCall,
    service: Service,
    x_call_token: CallToken = "",
):
    return aws_operation(lambda: service.explain(str(call_id), x_call_token, body))


@router.post("/{call_id}/end")
def end_call(call_id: UUID, service: Service, x_call_token: CallToken = ""):
    return aws_operation(lambda: service.end(str(call_id), x_call_token))
