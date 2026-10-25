"""Connections to RDS PostgreSQL or local pgvector."""

import json

import psycopg
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import HTTPException
from psycopg.rows import dict_row

from app.core.aws import aws_client
from app.core.config import settings


def connect(row_factory=dict_row):
    if settings.DATABASE_URL:
        return psycopg.connect(
            settings.DATABASE_URL, row_factory=row_factory, connect_timeout=10
        )
    if settings.DATABASE_DATA_API and settings.DATABASE_CLUSTER_ARN:
        from app.core.data_api import DataApiConnection

        return DataApiConnection(row_factory=row_factory)
    if settings.DATABASE_HOST and settings.DATABASE_SECRET_ARN:
        try:
            secret = json.loads(
                aws_client("secretsmanager").get_secret_value(
                    SecretId=settings.DATABASE_SECRET_ARN
                )["SecretString"]
            )
        except (BotoCoreError, ClientError, KeyError, ValueError) as exc:
            raise HTTPException(503, "Database credentials unavailable.") from exc
        return psycopg.connect(
            host=settings.DATABASE_HOST,
            port=settings.DATABASE_PORT,
            dbname=settings.DATABASE_NAME,
            user=secret["username"],
            password=secret["password"],
            sslmode="require",
            row_factory=row_factory,
            connect_timeout=10,
        )
    raise HTTPException(503, "Configure the database and run migrations first.")


def get_db():
    try:
        with connect() as connection:
            yield connection
    except (psycopg.OperationalError, BotoCoreError, ClientError) as exc:
        raise HTTPException(503, "Database unavailable. Please try again.") from exc
