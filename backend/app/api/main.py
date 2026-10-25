from fastapi import APIRouter

from app.api.routes import home, users

api_router = APIRouter()
api_router.include_router(home.router)
api_router.include_router(users.router)
