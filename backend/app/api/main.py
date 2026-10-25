from fastapi import APIRouter

from app.api.routes import calls, home

api_router = APIRouter()
api_router.include_router(home.router)
api_router.include_router(calls.router)
