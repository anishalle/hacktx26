from fastapi import APIRouter

from app.api.routes import home

api_router = APIRouter()
api_router.include_router(home.router)
