"""Room repository functions."""

from __future__ import annotations

import time
import uuid
from typing import Optional

from .db import get_conn, transaction
from .schemas import Room


def create_room(name: str, rate_per_minute: float = 8.0) -> Room:
    rid = uuid.uuid4().hex[:8]
    now = time.time()
    with transaction() as conn:
        conn.execute(
            "INSERT INTO rooms (id, name, created_at, rate_per_minute) VALUES (?, ?, ?, ?)",
            (rid, name, now, rate_per_minute),
        )
    return Room(id=rid, name=name, created_at=now, rate_per_minute=rate_per_minute)


def list_rooms() -> list[Room]:
    rows = (
        get_conn()
        .execute(
            "SELECT id, name, created_at, timer_started_at, rate_per_minute, skip_mode, owner_user_id, theme, ends_at FROM rooms ORDER BY created_at DESC"
        )
        .fetchall()
    )
    return [Room(**dict(r)) for r in rows]


def get_room(room_id: str) -> Optional[Room]:
    row = (
        get_conn()
        .execute(
            "SELECT id, name, created_at, timer_started_at, rate_per_minute, skip_mode, owner_user_id, theme, ends_at FROM rooms WHERE id = ?",
            (room_id,),
        )
        .fetchone()
    )
    return Room(**dict(row)) if row else None


def start_timer(room_id: str) -> Optional[Room]:
    now = time.time()
    with transaction() as conn:
        cur = conn.execute(
            "UPDATE rooms SET timer_started_at = COALESCE(timer_started_at, ?) WHERE id = ?",
            (now, room_id),
        )
        if cur.rowcount == 0:
            return None
    return get_room(room_id)


def reset_timer(room_id: str) -> Optional[Room]:
    with transaction() as conn:
        cur = conn.execute(
            "UPDATE rooms SET timer_started_at = NULL WHERE id = ?",
            (room_id,),
        )
        if cur.rowcount == 0:
            return None
    return get_room(room_id)


def delete_room(room_id: str) -> bool:
    with transaction() as conn:
        cur = conn.execute("DELETE FROM rooms WHERE id = ?", (room_id,))
        return cur.rowcount > 0


def set_owner(room_id: str, owner_user_id: str) -> bool:
    with transaction() as conn:
        cur = conn.execute(
            "UPDATE rooms SET owner_user_id = ? WHERE id = ?", (owner_user_id, room_id)
        )
        return cur.rowcount > 0


def set_skip_mode(room_id: str, mode: str) -> bool:
    if mode not in {"owner", "vote"}:
        return False
    with transaction() as conn:
        cur = conn.execute("UPDATE rooms SET skip_mode = ? WHERE id = ?", (mode, room_id))
        return cur.rowcount > 0


def set_theme(room_id: str, theme: str) -> bool:
    with transaction() as conn:
        cur = conn.execute("UPDATE rooms SET theme = ? WHERE id = ?", (theme, room_id))
        return cur.rowcount > 0


def set_ends_at(room_id: str, ends_at: float | None) -> bool:
    with transaction() as conn:
        cur = conn.execute("UPDATE rooms SET ends_at = ? WHERE id = ?", (ends_at, room_id))
        return cur.rowcount > 0
