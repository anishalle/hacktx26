from fastapi import APIRouter

from app.api.routes import call, home, rooms

api_router = APIRouter()
api_router.include_router(home.router)
api_router.include_router(call.router)

api_router.include_router(rooms.router)
