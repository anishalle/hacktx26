from fastapi import APIRouter

from app.api.routes import (
    calls,
    catchup,
    explain,
    groups,
    home,
    media,
    nudge,
    users,
    ws,
)

api_router = APIRouter()
api_router.include_router(home.router)
api_router.include_router(users.router)
api_router.include_router(groups.router)
api_router.include_router(media.router)
api_router.include_router(ws.router)
api_router.include_router(explain.router)
api_router.include_router(calls.router)
api_router.include_router(nudge.router)
api_router.include_router(catchup.router)
