from fastapi import Header, HTTPException

from app.core.config import settings


def current_user(x_demo_user: str = Header(default="priya")) -> str:
    # Accounts are outside demo scope. This identity selector is NOT authentication.
    if not settings.DEMO_MODE:
        raise HTTPException(503, "Configure authentication before disabling demo mode.")
    if x_demo_user not in {"priya", "swayam", "alex"}:
        raise HTTPException(403, "Unknown demo user")
    return x_demo_user
