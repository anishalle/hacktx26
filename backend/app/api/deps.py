from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import db


async def get_session() -> AsyncIterator[AsyncSession]:
    async with db.SessionLocal() as session:
        yield session


SessionDep = Annotated[AsyncSession, Depends(get_session)]
