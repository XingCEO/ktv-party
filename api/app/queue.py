"""Queue repository with fair-rotation ordering."""

from __future__ import annotations

import sqlite3
import time
from typing import Optional
import math

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
        performance_mode=(
            r["performance_mode"]
            if "performance_mode" in r.keys() and r["performance_mode"]
            else "solo"
        ),
        duet_partner_user_id=(
            r["duet_partner_user_id"] if "duet_partner_user_id" in r.keys() else None
        ),
        duet_partner_nickname=(
            r["duet_partner_nickname"] if "duet_partner_nickname" in r.keys() else None
        ),
        dedicate_to_user_id=(
            r["dedicate_to_user_id"] if "dedicate_to_user_id" in r.keys() else None
        ),
        dedicate_to_nickname=(
            r["dedicate_to_nickname"] if "dedicate_to_nickname" in r.keys() else None
        ),
        position=r["position"],
        status=r["status"],
        added_at=r["added_at"],
        started_at=r["started_at"] if "started_at" in r.keys() else None,
    )


def list_queue(room_id: str, include_done: bool = False) -> list[QueueItem]:
    sql = (
        "SELECT * FROM queue_items WHERE room_id = ? "
        + ("" if include_done else "AND status IN ('queued','playing') ")
        + "ORDER BY position ASC, id ASC"
    )
    rows = get_conn().execute(sql, (room_id,)).fetchall()
    return [_row_to_item(r) for r in rows]


def _upsert_song(
    conn,
    video_id: str,
    title: str,
    channel: Optional[str],
    duration_sec: Optional[int],
    thumbnail_url: Optional[str],
) -> None:
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
        # Duet lock: one active duet pair at a time for fairness and clarity.
        if payload.performance_mode == "duet":
            if not payload.user_id or not payload.duet_partner_user_id:
                raise ValueError("duet mode requires user_id and duet_partner_user_id")
            pair_a = payload.user_id
            pair_b = payload.duet_partner_user_id
            existing = conn.execute(
                """SELECT user_id, duet_partner_user_id
                   FROM queue_items
                   WHERE room_id = ? AND status IN ('queued','playing') AND performance_mode = 'duet'""",
                (room_id,),
            ).fetchall()
            for row in existing:
                u = row["user_id"]
                p = row["duet_partner_user_id"]
                if not u or not p:
                    continue
                same_pair = {u, p} == {pair_a, pair_b}
                if not same_pair:
                    raise ValueError("another duet pair is active in queue")

        _upsert_song(
            conn,
            payload.video_id,
            payload.title,
            payload.channel,
            payload.duration_sec,
            payload.thumbnail_url,
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
        try:
            cur = conn.execute(
                """INSERT INTO queue_items
                   (room_id, user_id, nickname, video_id, title, duration_sec,
                    thumbnail_url, vocal_mode, performance_mode, duet_partner_user_id,
                    duet_partner_nickname, dedicate_to_user_id, dedicate_to_nickname,
                    position, status, added_at, started_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    room_id,
                    payload.user_id,
                    payload.nickname,
                    payload.video_id,
                    payload.title,
                    payload.duration_sec,
                    payload.thumbnail_url,
                    payload.vocal_mode,
                    payload.performance_mode,
                    payload.duet_partner_user_id,
                    payload.duet_partner_nickname,
                    payload.dedicate_to_user_id,
                    payload.dedicate_to_nickname,
                    new_pos,
                    initial_status,
                    now,
                    now if initial_status == "playing" else None,
                ),
            )
        except sqlite3.IntegrityError:
            # Concurrent insert already claimed 'playing' for this room; fall back to 'queued'.
            max_pos_row2 = conn.execute(
                "SELECT COALESCE(MAX(position), 0) AS mp FROM queue_items WHERE room_id = ? AND status IN ('queued','playing')",
                (room_id,),
            ).fetchone()
            new_pos = (max_pos_row2["mp"] or 0) + 1
            cur = conn.execute(
                """INSERT INTO queue_items
                   (room_id, user_id, nickname, video_id, title, duration_sec,
                    thumbnail_url, vocal_mode, performance_mode, duet_partner_user_id,
                    duet_partner_nickname, dedicate_to_user_id, dedicate_to_nickname,
                    position, status, added_at, started_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    room_id,
                    payload.user_id,
                    payload.nickname,
                    payload.video_id,
                    payload.title,
                    payload.duration_sec,
                    payload.thumbnail_url,
                    payload.vocal_mode,
                    payload.performance_mode,
                    payload.duet_partner_user_id,
                    payload.duet_partner_nickname,
                    payload.dedicate_to_user_id,
                    payload.dedicate_to_nickname,
                    new_pos,
                    "queued",
                    now,
                    None,
                ),
            )
        item_id = cur.lastrowid
    # Apply fair rotation rebalance.
    apply_fair_rotation(room_id)
    row = get_conn().execute("SELECT * FROM queue_items WHERE id = ?", (item_id,)).fetchone()
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
            if r["position"] != start + offset:
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
    if len(item_ids) != len(set(item_ids)):
        raise ValueError("duplicate ids")
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
    row = (
        get_conn()
        .execute(
            "SELECT * FROM queue_items WHERE room_id = ? AND status = 'playing' ORDER BY position ASC LIMIT 1",
            (room_id,),
        )
        .fetchone()
    )
    return _row_to_item(row) if row else None


def advance_to_next(room_id: str) -> Optional[QueueItem]:
    """Mark current playing as done and start the next queued item.

    Records the completed song in song_history so charts / personal history /
    recommendations populate on natural completion — not only when a song is
    explicitly skipped. This is the path the scheduler, the /playback/next
    endpoint, and the TV end-hint all funnel through.
    """
    completed: Optional[QueueItem] = None
    started_next = False
    with transaction() as conn:
        prev = conn.execute(
            "SELECT * FROM queue_items WHERE room_id = ? AND status = 'playing' ORDER BY position ASC LIMIT 1",
            (room_id,),
        ).fetchone()
        if prev:
            completed = _row_to_item(prev)
        conn.execute(
            "UPDATE queue_items SET status = 'done' WHERE room_id = ? AND status = 'playing'",
            (room_id,),
        )
        row = conn.execute(
            "SELECT * FROM queue_items WHERE room_id = ? AND status = 'queued' ORDER BY position ASC, id ASC LIMIT 1",
            (room_id,),
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE queue_items SET status = 'playing', started_at = ? WHERE id = ?",
                (
                    time.time(),
                    row["id"],
                ),
            )
            started_next = True
    # Save history after the transaction commits (save_song_history opens its own).
    if completed:
        save_song_history(room_id, completed)
    return get_current_playing(room_id) if started_next else None


def skip_current(room_id: str) -> Optional[QueueItem]:
    with transaction() as conn:
        conn.execute(
            "UPDATE queue_items SET status = 'skipped' WHERE room_id = ? AND status = 'playing'",
            (room_id,),
        )
    return advance_to_next(room_id)


def save_song_history(room_id: str, item: QueueItem) -> None:
    with transaction() as conn:
        conn.execute(
            "INSERT INTO song_history (room_id, user_id, nickname, video_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (room_id, item.user_id, item.nickname, item.video_id, item.title, time.time()),
        )


def vote_skip(
    room_id: str, item_id: int, user_id: str, participant_count: int
) -> tuple[int, int, bool]:
    with transaction() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO vote_skip (room_id, item_id, user_id, created_at) VALUES (?, ?, ?, ?)",
            (room_id, item_id, user_id, time.time()),
        )
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM vote_skip WHERE room_id = ? AND item_id = ?",
            (room_id, item_id),
        ).fetchone()
    votes = int(row["c"] if row else 0)
    threshold = max(1, math.ceil(max(1, participant_count) / 2))
    return votes, threshold, votes >= threshold


def clear_votes(room_id: str, item_id: int) -> None:
    with transaction() as conn:
        conn.execute("DELETE FROM vote_skip WHERE room_id = ? AND item_id = ?", (room_id, item_id))


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
            "UPDATE queue_items SET status = 'playing', started_at = ? WHERE id = ?",
            (
                time.time(),
                row["id"],
            ),
        )
    return get_current_playing(room_id)
