"""Feature 1: hold-to-explain.

Paths: `/explain`, `/ask-member`, `/ask-member/{ask_id}/answer`,
`/users/{user_id}/asks`.

Logic lives in app/services/explain.py (retrieval + grounded answer) and
app/services/asks.py (the private ask fallback). Routes carry full paths (no router
prefix) because the ask list sits under /users.
"""

from fastapi import APIRouter

from app import schemas
from app.api.deps import SessionDep
from app.services import asks, explain

router = APIRouter(tags=["explain"])


@router.post("/explain", response_model=schemas.Explanation)
async def explain_message(
    body: schemas.ExplainRequest, session: SessionDep
) -> schemas.Explanation:
    return await explain.explain(session, body)


@router.post("/ask-member", response_model=schemas.MemberAsk, status_code=201)
async def ask_member(body: schemas.AskCreate, session: SessionDep) -> schemas.MemberAsk:
    return await asks.create_ask(session, body)


@router.post("/ask-member/{ask_id}/answer", response_model=schemas.MemberAsk)
async def answer_ask(
    ask_id: int, body: schemas.AskAnswer, session: SessionDep
) -> schemas.MemberAsk:
    return await asks.answer_ask(session, ask_id, body)


@router.get("/users/{user_id}/asks", response_model=schemas.AskList)
async def list_asks(user_id: str, session: SessionDep) -> schemas.AskList:
    return await asks.list_asks(session, user_id)
