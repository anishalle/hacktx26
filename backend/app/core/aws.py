from functools import lru_cache

import boto3
from botocore.config import Config

from app.core.config import settings


@lru_cache
def session():
    return boto3.Session(
        profile_name=settings.AWS_PROFILE, region_name=settings.AWS_REGION
    )


@lru_cache
def aws_client(service: str):
    return session().client(
        service,
        config=Config(
            connect_timeout=10,
            read_timeout=90,
            retries={"max_attempts": 3, "mode": "standard"},
        ),
    )
