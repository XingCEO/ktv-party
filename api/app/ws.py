"""Per-room WebSocket connection manager with broadcast isolation."""
from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


import time

class RoomBroker:
    def __init__(self) -> None:
        self._rooms: dict[str, set[WebSocket]] = defaultdict(set)
        self._room_identities: dict[str, dict[WebSocket, dict[str, Any]]] = defaultdict(dict)
        self._lock = asyncio.Lock()

    async def connect(self, room_id: str, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._rooms[room_id].add(ws)

    async def disconnect(self, room_id: str, ws: WebSocket) -> None:
        async with self._lock:
            if room_id in self._rooms:
                self._rooms[room_id].discard(ws)
                self._room_identities[room_id].pop(ws, None)
                if not self._rooms[room_id]:
                    self._rooms.pop(room_id, None)
                    self._room_identities.pop(room_id, None)

    async def set_identity(self, room_id: str, ws: WebSocket, identity: dict[str, Any]) -> None:
        """Called when client sends an `identity` event after connect."""
        async with self._lock:
            self._room_identities[room_id][ws] = identity

    def list_identities(self, room_id: str) -> list[dict[str, Any]]:
        return list(self._room_identities.get(room_id, {}).values())

    async def broadcast(self, room_id: str, event: str, payload: dict[str, Any], exclude: WebSocket | None = None) -> None:
        msg = json.dumps({"event": event, "data": payload}, ensure_ascii=False)
        async with self._lock:
            sockets = [s for s in self._rooms.get(room_id, ()) if s is not exclude]
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
                bucket = self._rooms.get(room_id)
                # Defensively discard only if the bucket still exists and the socket is in it
                if bucket is not None:
                    for s in dead:
                        if s in bucket:
                            bucket.discard(s)
                    if not bucket:
                        self._rooms.pop(room_id, None)

    async def prune_stale(self) -> None:
        """Sends a ping to all sockets in all rooms, dropping those that fail/timeout."""
        msg = json.dumps({"event": "server.ping", "data": {"ts": time.time()}}, ensure_ascii=False)
        async with self._lock:
            snapshot = {r_id: list(sockets) for r_id, sockets in self._rooms.items() if sockets}
            
        if not snapshot:
            return

        async def _ping(s: WebSocket, r_id: str) -> tuple[str, WebSocket] | None:
            try:
                await asyncio.wait_for(s.send_text(msg), timeout=5.0)
                return None
            except Exception:
                return (r_id, s)

        tasks = []
        for r_id, sockets in snapshot.items():
            for s in sockets:
                tasks.append(_ping(s, r_id))
                
        results = await asyncio.gather(*tasks, return_exceptions=False)
        dead = [res for res in results if res is not None]
        
        if dead:
            async with self._lock:
                for r_id, s in dead:
                    bucket = self._rooms.get(r_id)
                    if bucket is not None and s in bucket:
                        bucket.discard(s)
                        if not bucket:
                            self._rooms.pop(r_id, None)

    def room_count(self, room_id: str) -> int:
        return len(self._rooms.get(room_id, ()))


broker = RoomBroker()


async def safe_broadcast(room_id: str, event: str, payload: dict[str, Any], exclude: WebSocket | None = None) -> None:
    """Broadcast wrapper that swallows errors so callers don't break on WS issues."""
    try:
        await broker.broadcast(room_id, event, payload, exclude=exclude)
    except Exception:
        logger.exception("broadcast failed room=%s event=%s", room_id, event)
