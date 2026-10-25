"""API schemas live here; add SQLModel table models when persistence is needed."""

from typing import Literal

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: Literal["ok"]
