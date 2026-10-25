"""Aurora PostgreSQL access via RDS Data API (no VPC/TCP needed)."""

import boto3

from app.core.config import settings

_client = None


def get_rds_client():
    global _client
    if _client is None:
        _client = boto3.client("rds-data", region_name=settings.AWS_REGION)
    return _client


def execute_sql(sql: str, parameters: list[dict] | None = None) -> dict:
    """Run a single SQL statement via Data API. Returns the response dict."""
    client = get_rds_client()
    kwargs = {
        "resourceArn": settings.DATABASE_CLUSTER_ARN,
        "secretArn": settings.DATABASE_SECRET_ARN,
        "database": settings.DATABASE_NAME,
        "sql": sql,
    }
    if parameters:
        kwargs["parameters"] = parameters
    return client.execute_statement(**kwargs)


def init_schema():
    """Create tables if they don't exist. Safe to call on every cold start."""
    execute_sql("""
        CREATE TABLE IF NOT EXISTS call_transcripts (
            id BIGSERIAL PRIMARY KEY,
            call_id TEXT NOT NULL,
            speaker_id TEXT NOT NULL,
            speaker_name TEXT NOT NULL,
            text TEXT NOT NULL,
            start_ms BIGINT NOT NULL,
            end_ms BIGINT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    execute_sql("""
        CREATE INDEX IF NOT EXISTS idx_transcript_call
        ON call_transcripts (call_id, start_ms)
    """)
