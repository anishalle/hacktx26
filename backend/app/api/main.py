from fastapi import APIRouter

from app.api.routes import catchup, explain, groups, home, nudge, users, ws

api_router = APIRouter()
api_router.include_router(home.router)
api_router.include_router(users.router)
api_router.include_router(groups.router)
api_router.include_router(ws.router)
api_router.include_router(explain.router)
api_router.include_router(nudge.router)
api_router.include_router(catchup.router)
