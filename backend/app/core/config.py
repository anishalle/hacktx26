from pathlib import Path
from typing import Literal

from pydantic import HttpUrl
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parents[3] / ".env",
        env_ignore_empty=True,
        extra="ignore",
    )

    PROJECT_NAME: str = "HackRice 26"
    API_V1_STR: str = "/api/v1"
    FRONTEND_HOST: str = "http://localhost:5173"
    FASTAPI_ENV: Literal["development", "staging", "production"] = "development"
    SENTRY_DSN: HttpUrl | None = None
    AWS_REGION: str = "us-east-1"
    DATABASE_CLUSTER_ARN: str = ""
    DATABASE_SECRET_ARN: str = ""
    DATABASE_NAME: str = "newcomer"
    GENERATION_MODEL_ID: str = "amazon.nova-lite-v1:0"
    CALLS_DEMO_API_KEY: str = ""


settings = Settings()
