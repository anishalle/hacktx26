from pathlib import Path
from typing import Literal

from pydantic import HttpUrl, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parents[3] / ".env",
        env_ignore_empty=True,
        extra="ignore",
    )

    PROJECT_NAME: str = "HackTX 26"
    API_V1_STR: str = "/api/v1"
    FRONTEND_HOST: str = "http://localhost:8081"
    FASTAPI_ENV: Literal["development", "staging", "production"] = "development"
    SENTRY_DSN: HttpUrl | None = None

    # Shared database is Timescale Cloud; a pasted `postgres://` URL works as-is.
    DATABASE_URL: str = "postgresql+psycopg://hacktx:hacktx@localhost:5433/hacktx"
    # Tests drop and recreate tables, so they never run against DATABASE_URL.
    TEST_DATABASE_URL: str = "postgresql+psycopg://hacktx:hacktx@localhost:5433/hacktx"

    MODEL_API_BASE_URL: str = "https://api.meta.ai/v1"
    MODEL_API_KEY: str = ""
    LLM_MODEL: str = "muse-spark-1.3"
    LLM_REASONING_EFFORT: str | None = "minimal"
    LLM_TIMEOUT_S: float = 20.0
    # Feature 1 embeddings: Bedrock Titan v2 with the default AWS credential chain.
    # Without credentials, retrieval is full-text only.
    AWS_REGION: str = "us-east-1"
    EMBEDDING_MODEL_ID: str = "amazon.titan-embed-text-v2:0"
    EMBEDDING_DIM: int = 1024
    EMBEDDING_WINDOW: int = 10

    NEWCOMER_BADGE_DAYS: int = 7
    CATCHUP_MIN_UNREAD: int = 50
    DIGEST_CHUNK_SIZE: int = 100

    @field_validator("DATABASE_URL", "TEST_DATABASE_URL")
    @classmethod
    def _use_psycopg(cls, url: str) -> str:
        for prefix in ("postgres://", "postgresql://"):
            if url.startswith(prefix):
                return "postgresql+psycopg://" + url.removeprefix(prefix)
        return url


settings = Settings()
