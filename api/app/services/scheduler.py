"""Server-side playback scheduler.

Periodically scans rooms for the currently-playing song. When the song's
expected end time has passed (started_at + duration_sec + GRACE_SEC), advances
the queue. This makes the server — not the TV browser — the source of truth
for playback advancement, so a crashed/refreshed TV doesn't block the queue.
"""

import asyncio
import logging
import time

from .. import queue as queue_repo
from ..ws import safe_broadcast
from . import charts

logger = logging.getLogger(__name__)
GRACE_SEC = 8.0  # cushion after expected end before server force-advances
SCAN_INTERVAL_SEC = 5.0
_COUNTDOWN_MILESTONES = (600, 300, 60)
_SENT_COUNTDOWN: set[tuple[str, int]] = set()


async def scheduler_loop() -> None:
    """Run forever. Scan all rooms; force-advance songs that should have ended."""
    while True:
        try:
            await _tick()
        except Exception:
            logger.exception("scheduler_loop tick failed")
        await asyncio.sleep(SCAN_INTERVAL_SEC)


async def _tick() -> None:
    await charts.sync_daily_charts()
    # Get all rooms with a playing item; check if it should have ended.
    from ..db import get_conn

    conn = get_conn()
    now = time.time()

    # Session countdown notifications (10/5/1 min)
    rooms = conn.execute("SELECT id, ends_at FROM rooms WHERE ends_at IS NOT NULL").fetchall()
    for room in rooms:
        ends_at = room["ends_at"]
        if not ends_at:
            continue
        remain = int(max(0, ends_at - now))
        for sec in _COUNTDOWN_MILESTONES:
            key = (room["id"], sec)
            if remain <= sec and key not in _SENT_COUNTDOWN:
                _SENT_COUNTDOWN.add(key)
                await safe_broadcast(
                    room["id"],
                    "room.countdown",
                    {"remaining_sec": remain, "milestone_sec": sec},
                )

    rows = conn.execute(
        """SELECT room_id, id, video_id, started_at, duration_sec
           FROM queue_items WHERE status = 'playing' """
    ).fetchall()
    for r in rows:
        started = r["started_at"]
        dur = r["duration_sec"]
        # If we don't have started_at (legacy row) or duration, skip — only
        # the TV's ended event can advance these. Also skip songs without a
        # known duration; we won't auto-advance them.
        if started is None or dur is None or dur <= 0:
            continue
        if now >= started + dur + GRACE_SEC:
            logger.info(
                "scheduler force-advance room=%s item=%d (overdue %.1fs)",
                r["room_id"],
                r["id"],
                now - (started + dur),
            )
            await _advance_room(r["room_id"])


async def _advance_room(room_id: str) -> None:
    item = queue_repo.advance_to_next(room_id)
    full = queue_repo.list_queue(room_id)
    next_starts_at = None
    if item and item.duration_sec:
        next_starts_at = time.time() + item.duration_sec
    await safe_broadcast(
        room_id,
        "playback.advanced",
        {
            "current": item.model_dump() if item else None,
            "queue": [i.model_dump() for i in full],
            "next_starts_at": next_starts_at,
            "reason": "server_scheduler",
        },
    )
