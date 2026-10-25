from fastapi import APIRouter

from app.api.routes import chat, home

api_router = APIRouter()
api_router.include_router(home.router)
api_router.include_router(chat.router)
