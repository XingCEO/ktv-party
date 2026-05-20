from __future__ import annotations

import time
from typing import Any

import httpx

from ..db import get_conn


_LAST_SYNC_AT = 0.0


async def sync_daily_charts() -> None:
    global _LAST_SYNC_AT
    now = time.time()
    if now - _LAST_SYNC_AT < 20 * 3600:
        return
    _LAST_SYNC_AT = now
    await _sync_itunes_tw_top100()


async def _sync_itunes_tw_top100() -> None:
    url = "https://rss.applemarketingtools.com/api/v2/tw/music/most-played/100/songs.json"
    async with httpx.AsyncClient(timeout=12.0) as client:
        r = await client.get(url)
        if r.status_code != 200:
            return
        data: dict[str, Any] = r.json()
    items = (data.get("feed") or {}).get("results") or []
    conn = get_conn()
    created_at = time.time()
    conn.execute("DELETE FROM charts_cache WHERE source = ?", ("applemusic",))
    for idx, it in enumerate(items, start=1):
        title = str(it.get("name") or "")
        artist = str(it.get("artistName") or "")
        if not title:
            continue
        conn.execute(
            "INSERT INTO charts_cache (source, chart_key, video_id, title, artist, rank_no, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("applemusic", "tw-top100", f"apple:{idx}:{title}", title, artist, idx, created_at),
        )
