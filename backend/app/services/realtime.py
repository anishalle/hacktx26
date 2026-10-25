"""In-process WebSocket hub keyed by user_id; frames are {"type", "data"}."""

import asyncio
import logging
from collections import defaultdict
from typing import Any

from fastapi import WebSocket
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud

log = logging.getLogger(__name__)


class Hub:
    def __init__(self) -> None:
        self.sockets: dict[str, set[WebSocket]] = defaultdict(set)

    def connect(self, user_id: str, ws: WebSocket) -> None:
        self.sockets[user_id].add(ws)

    def disconnect(self, user_id: str, ws: WebSocket) -> None:
        conns = self.sockets.get(user_id)
        if conns is not None:
            conns.discard(ws)
            if not conns:
                del self.sockets[user_id]

    def clear(self) -> None:
        self.sockets.clear()

    async def send(
        self, user_ids: list[str], type: str, data: BaseModel | dict[str, Any]
    ) -> None:
        payload = data.model_dump(mode="json") if isinstance(data, BaseModel) else data
        frame = {"type": type, "data": payload}
        targets = [
            (uid, ws) for uid in user_ids for ws in list(self.sockets.get(uid, ()))
        ]
        results = await asyncio.gather(
            *(ws.send_json(frame) for _, ws in targets), return_exceptions=True
        )
        for (uid, ws), result in zip(targets, results, strict=True):
            if isinstance(result, Exception):
                log.debug("dropping dead socket for %s: %r", uid, result)
                self.disconnect(uid, ws)


hub = Hub()


async def broadcast_group(
    session: AsyncSession, group_id: int, type: str, data: BaseModel | dict[str, Any]
) -> None:
    """Push one frame to every member of the group (sender included)."""
    await hub.send(await crud.member_ids(session, group_id), type, data)
