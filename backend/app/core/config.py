from pathlib import Path
from typing import Literal

from pydantic import Field, HttpUrl
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(
            Path(__file__).resolve().parents[3] / ".env.aws.local",
            Path(__file__).resolve().parents[3] / ".env",
        ),
        env_ignore_empty=True,
        extra="ignore",
    )

    PROJECT_NAME: str = "HackRice 26"
    API_V1_STR: str = "/api/v1"
    FRONTEND_HOST: str = "http://localhost:8081"
    FASTAPI_ENV: Literal["development", "staging", "production"] = "development"
    SENTRY_DSN: HttpUrl | None = None
    DATABASE_URL: str = ""
    DATABASE_HOST: str = ""
    DATABASE_PORT: int = 5432
    DATABASE_NAME: str = "postgres"
    DATABASE_SECRET_ARN: str = ""
    DATABASE_CLUSTER_ARN: str = ""
    DATABASE_DATA_API: bool = True
    AWS_REGION: str = "us-east-1"
    AWS_PROFILE: str | None = None
    BEDROCK_EMBEDDING_MODEL_ID: str = "amazon.titan-embed-text-v2:0"
    BEDROCK_CLAUDE_MODEL_ID: str = ""
    RETRIEVAL_HITS: int = Field(default=3, ge=1, le=8)
    CONTEXT_MAX_CHARS: int = Field(default=240000, ge=1000, le=400000)
    DEMO_MODE: bool = True


settings = Settings()
