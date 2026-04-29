"""Per-room WebSocket connection manager with broadcast isolation."""
from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class RoomBroker:
    def __init__(self) -> None:
        self._rooms: dict[str, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, room_id: str, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._rooms[room_id].add(ws)

    async def disconnect(self, room_id: str, ws: WebSocket) -> None:
        async with self._lock:
            self._rooms[room_id].discard(ws)
            if not self._rooms[room_id]:
                self._rooms.pop(room_id, None)

    async def broadcast(self, room_id: str, event: str, payload: dict[str, Any]) -> None:
        msg = json.dumps({"event": event, "data": payload}, ensure_ascii=False)
        async with self._lock:
            sockets = list(self._rooms.get(room_id, ()))
        if not sockets:
            return

        async def _send(s: WebSocket) -> WebSocket | None:
            try:
                await asyncio.wait_for(s.send_text(msg), timeout=5.0)
                return None
            except Exception as exc:
                logger.warning("ws send failed room=%s err=%s", room_id, exc)
                return s

        results = await asyncio.gather(*(_send(s) for s in sockets), return_exceptions=False)
        dead = [s for s in results if s is not None]
        if dead:
            async with self._lock:
                bucket = self._rooms.get(room_id, set())
                for s in dead:
                    bucket.discard(s)

    def room_count(self, room_id: str) -> int:
        return len(self._rooms.get(room_id, ()))


broker = RoomBroker()


async def safe_broadcast(room_id: str, event: str, payload: dict[str, Any]) -> None:
    """Broadcast wrapper that swallows errors so callers don't break on WS issues."""
    try:
        await broker.broadcast(room_id, event, payload)
    except Exception:
        logger.exception("broadcast failed room=%s event=%s", room_id, event)
