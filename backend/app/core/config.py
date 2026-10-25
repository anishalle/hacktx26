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

    PROJECT_NAME: str = "HackTX Newcomer Assistant"
    API_V1_STR: str = "/api/v1"
    FRONTEND_HOST: str = "http://localhost:5173"
    FASTAPI_ENV: Literal["development", "staging", "production"] = "development"
    SENTRY_DSN: HttpUrl | None = None

    # AWS / Bedrock
    DATABASE_NAME: str = "newcomer"
    DATABASE_CLUSTER_ARN: str = ""
    DATABASE_SECRET_ARN: str = ""
    GENERATION_MODEL_ID: str = "amazon.nova-lite-v1:0"
    EMBEDDING_MODEL_ID: str = "amazon.titan-embed-text-v2:0"
    MEDIA_BUCKET: str = ""
    AWS_REGION: str = "us-east-1"

    # LiveKit credentials stay on the backend.
    LIVEKIT_URL: str = ""
    LIVEKIT_API_KEY: str = ""
    LIVEKIT_API_SECRET: str = ""

    # Budget guardrails
    MAX_BEDROCK_REQUESTS_PER_MINUTE: int = 20
    MAX_BEDROCK_REQUESTS_PER_HOUR: int = 200
    MAX_INPUT_TOKENS_PER_REQUEST: int = 2000
    MAX_OUTPUT_TOKENS_PER_REQUEST: int = 150


settings = Settings()
