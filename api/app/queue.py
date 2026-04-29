"""Queue repository with fair-rotation ordering."""
from __future__ import annotations

import time
from typing import Optional

from .db import get_conn, transaction
from .schemas import QueueAdd, QueueItem


def _row_to_item(r) -> QueueItem:
    return QueueItem(
        id=r["id"],
        room_id=r["room_id"],
        user_id=r["user_id"],
        nickname=r["nickname"],
        video_id=r["video_id"],
        title=r["title"],
        duration_sec=r["duration_sec"],
        thumbnail_url=r["thumbnail_url"],
        vocal_mode=r["vocal_mode"],
        position=r["position"],
        status=r["status"],
        added_at=r["added_at"],
    )


def list_queue(room_id: str, include_done: bool = False) -> list[QueueItem]:
    sql = (
        "SELECT * FROM queue_items WHERE room_id = ? "
        + ("" if include_done else "AND status IN ('queued','playing') ")
        + "ORDER BY position ASC, id ASC"
    )
    rows = get_conn().execute(sql, (room_id,)).fetchall()
    return [_row_to_item(r) for r in rows]


def _upsert_song(conn, video_id: str, title: str, channel: Optional[str],
                 duration_sec: Optional[int], thumbnail_url: Optional[str]) -> None:
    now = time.time()
    conn.execute(
        """INSERT INTO songs (video_id, title, channel, duration_sec, thumbnail_url, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(video_id) DO UPDATE SET
             title=excluded.title,
             channel=COALESCE(excluded.channel, songs.channel),
             duration_sec=COALESCE(excluded.duration_sec, songs.duration_sec),
             thumbnail_url=COALESCE(excluded.thumbnail_url, songs.thumbnail_url),
             last_seen_at=excluded.last_seen_at""",
        (video_id, title, channel, duration_sec, thumbnail_url, now),
    )


def add_to_queue(room_id: str, payload: QueueAdd) -> QueueItem:
    """Append using fair rotation - atomic insert + auto-promote if room is idle."""
    now = time.time()
    with transaction() as conn:
        _upsert_song(
            conn, payload.video_id, payload.title, payload.channel,
            payload.duration_sec, payload.thumbnail_url,
        )
        max_pos_row = conn.execute(
            "SELECT COALESCE(MAX(position), 0) AS mp FROM queue_items WHERE room_id = ? AND status IN ('queued','playing')",
            (room_id,),
        ).fetchone()
        new_pos = (max_pos_row["mp"] or 0) + 1
        # Atomic idle check: if no playing row exists in this room, this insert becomes 'playing'.
        # SQLite's partial unique index (status='playing' per room_id) provides hard guard.
        playing_row = conn.execute(
            "SELECT 1 FROM queue_items WHERE room_id = ? AND status = 'playing' LIMIT 1",
            (room_id,),
        ).fetchone()
        initial_status = "queued" if playing_row else "playing"
        cur = conn.execute(
            """INSERT INTO queue_items
               (room_id, user_id, nickname, video_id, title, duration_sec,
                thumbnail_url, vocal_mode, position, status, added_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                room_id, payload.user_id, payload.nickname, payload.video_id,
                payload.title, payload.duration_sec, payload.thumbnail_url,
                payload.vocal_mode, new_pos, initial_status, now,
            ),
        )
        item_id = cur.lastrowid
    # Apply fair rotation rebalance.
    apply_fair_rotation(room_id)
    row = get_conn().execute(
        "SELECT * FROM queue_items WHERE id = ?", (item_id,)
    ).fetchone()
    return _row_to_item(row)


def apply_fair_rotation(room_id: str) -> None:
    """Re-order queued items so users are interleaved fairly.

    Algorithm: keep currently 'playing' item at position 0. For remaining 'queued'
    items, group by stable user_id (fall back to nickname when user_id is missing)
    preserving FIFO inside group. Then interleave groups in round-robin order based
    on the order their first song was originally added.
    """
    with transaction() as conn:
        items = conn.execute(
            "SELECT * FROM queue_items WHERE room_id = ? AND status = 'queued' ORDER BY position ASC, id ASC",
            (room_id,),
        ).fetchall()
        if not items:
            return
        groups: dict[str, list] = {}
        order: list[str] = []
        for r in items:
            # Group by stable user identity, not display nickname (which can change/collide).
            key = r["user_id"] or r["nickname"] or f"row:{r['id']}"
            if key not in groups:
                groups[key] = []
                order.append(key)
            groups[key].append(r)
        interleaved = []
        idx = 0
        while any(groups[n] for n in order):
            n = order[idx % len(order)]
            if groups[n]:
                interleaved.append(groups[n].pop(0))
            idx += 1
        # Determine starting position: after any 'playing' row.
        playing = conn.execute(
            "SELECT MAX(position) AS p FROM queue_items WHERE room_id = ? AND status = 'playing'",
            (room_id,),
        ).fetchone()
        start = (playing["p"] or 0) + 1
        for offset, r in enumerate(interleaved):
            conn.execute(
                "UPDATE queue_items SET position = ? WHERE id = ?",
                (start + offset, r["id"]),
            )


def remove_item(room_id: str, item_id: int) -> bool:
    with transaction() as conn:
        cur = conn.execute(
            "DELETE FROM queue_items WHERE room_id = ? AND id = ? AND status != 'playing'",
            (room_id, item_id),
        )
        deleted = cur.rowcount > 0
    if deleted:
        apply_fair_rotation(room_id)
    return deleted


def reorder_queue(room_id: str, item_ids: list[int]) -> list[QueueItem]:
    """Set explicit positions in given order (overrides fair rotation for this call)."""
    with transaction() as conn:
        rows = conn.execute(
            "SELECT id FROM queue_items WHERE room_id = ? AND status = 'queued'",
            (room_id,),
        ).fetchall()
        valid_ids = {r["id"] for r in rows}
        if set(item_ids) != valid_ids:
            raise ValueError("item_ids must include exactly all queued ids")
        playing = conn.execute(
            "SELECT MAX(position) AS p FROM queue_items WHERE room_id = ? AND status = 'playing'",
            (room_id,),
        ).fetchone()
        start = (playing["p"] or 0) + 1
        for offset, iid in enumerate(item_ids):
            conn.execute(
                "UPDATE queue_items SET position = ? WHERE id = ?",
                (start + offset, iid),
            )
    return list_queue(room_id)


def insert_next(room_id: str, item_id: int) -> bool:
    with transaction() as conn:
        playing = conn.execute(
            "SELECT MAX(position) AS p FROM queue_items WHERE room_id = ? AND status = 'playing'",
            (room_id,),
        ).fetchone()
        next_pos = (playing["p"] or 0) + 1
        # Bump everyone else with position >= next_pos by 1.
        conn.execute(
            "UPDATE queue_items SET position = position + 1 WHERE room_id = ? AND status='queued' AND position >= ? AND id != ?",
            (room_id, next_pos, item_id),
        )
        cur = conn.execute(
            "UPDATE queue_items SET position = ? WHERE id = ? AND room_id = ?",
            (next_pos, item_id, room_id),
        )
        return cur.rowcount > 0


def set_vocal_mode(room_id: str, item_id: int, mode: str) -> bool:
    with transaction() as conn:
        cur = conn.execute(
            "UPDATE queue_items SET vocal_mode = ? WHERE room_id = ? AND id = ? AND status != 'done'",
            (mode, room_id, item_id),
        )
        return cur.rowcount > 0


def get_current_playing(room_id: str) -> Optional[QueueItem]:
    row = get_conn().execute(
        "SELECT * FROM queue_items WHERE room_id = ? AND status = 'playing' ORDER BY position ASC LIMIT 1",
        (room_id,),
    ).fetchone()
    return _row_to_item(row) if row else None


def advance_to_next(room_id: str) -> Optional[QueueItem]:
    """Mark current playing as done and start the next queued item."""
    with transaction() as conn:
        conn.execute(
            "UPDATE queue_items SET status = 'done' WHERE room_id = ? AND status = 'playing'",
            (room_id,),
        )
        row = conn.execute(
            "SELECT * FROM queue_items WHERE room_id = ? AND status = 'queued' ORDER BY position ASC, id ASC LIMIT 1",
            (room_id,),
        ).fetchone()
        if not row:
            return None
        conn.execute(
            "UPDATE queue_items SET status = 'playing' WHERE id = ?",
            (row["id"],),
        )
    return get_current_playing(room_id)


def start_first_if_idle(room_id: str) -> Optional[QueueItem]:
    """Promote first queued item to playing if nothing is playing."""
    current = get_current_playing(room_id)
    if current:
        return current
    with transaction() as conn:
        row = conn.execute(
            "SELECT * FROM queue_items WHERE room_id = ? AND status = 'queued' ORDER BY position ASC, id ASC LIMIT 1",
            (room_id,),
        ).fetchone()
        if not row:
            return None
        conn.execute(
            "UPDATE queue_items SET status = 'playing' WHERE id = ?",
            (row["id"],),
        )
    return get_current_playing(room_id)
