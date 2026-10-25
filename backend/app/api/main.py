from fastapi import APIRouter

from app.api.routes import call, calls, home

api_router = APIRouter()
api_router.include_router(home.router)
api_router.include_router(calls.router)
api_router.include_router(call.router)
