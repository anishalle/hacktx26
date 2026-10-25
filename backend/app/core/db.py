"""Aurora PostgreSQL access via RDS Data API (no VPC/TCP needed)."""

from pathlib import Path

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
    """Compatibility helper; deploy normally applies this same canonical schema."""
    schema = Path(__file__).resolve().parents[1] / "calls/schema.sql"
    for statement in schema.read_text().split(";"):
        if statement.strip():
            execute_sql(statement.strip())
