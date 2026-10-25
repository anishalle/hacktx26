"""Feature 7: Guess that Lore. Logic lives in app/services/games.py."""

from fastapi import APIRouter

from app import schemas
from app.api.deps import SessionDep
from app.services import games

router = APIRouter(tags=["games"])


@router.post(
    "/groups/{group_id}/games", response_model=schemas.Message, status_code=201
)
async def start_game(
    group_id: int, body: schemas.GameStart, session: SessionDep
) -> schemas.Message:
    """Post a round about a random kept moment of this group (409 without Lore)."""
    return await games.start(session, group_id, body.user_id)


@router.post("/games/{game_id}/vote", response_model=schemas.Message)
async def vote_game(
    game_id: int, body: schemas.GameVote, session: SessionDep
) -> schemas.Message:
    return await games.vote(session, game_id, body)


@router.post("/games/{game_id}/hint", response_model=schemas.Message)
async def hint_game(
    game_id: int, body: schemas.GameStart, session: SessionDep
) -> schemas.Message:
    return await games.hint(session, game_id, body.user_id)


@router.post("/games/{game_id}/reveal", response_model=schemas.Message)
async def reveal_game(
    game_id: int, body: schemas.GameStart, session: SessionDep
) -> schemas.Message:
    return await games.reveal(session, game_id, body.user_id)
