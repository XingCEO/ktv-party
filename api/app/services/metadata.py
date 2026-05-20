from __future__ import annotations

import os
from typing import Any

import httpx


async def fetch_musicbrainz_artist(title: str, artist: str | None) -> str | None:
    q = f"recording:{title}"
    if artist:
        q += f" AND artist:{artist}"
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(
            "https://musicbrainz.org/ws/2/recording",
            params={"query": q, "fmt": "json", "limit": 1},
            headers={"User-Agent": "ktv-box/0.1 (metadata enrichment)"},
        )
    if r.status_code != 200:
        return None
    data: dict[str, Any] = r.json()
    recs = data.get("recordings") or []
    if not recs:
        return None
    artists = recs[0].get("artist-credit") or []
    if not artists:
        return None
    name = artists[0].get("name")
    return str(name) if name else None


async def fetch_spotify_artist_id(title: str, artist: str | None) -> tuple[str | None, str | None]:
    token = os.getenv("SPOTIFY_BEARER_TOKEN", "").strip()
    if not token:
        return None, None
    query = f"track:{title}"
    if artist:
        query += f" artist:{artist}"
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(
            "https://api.spotify.com/v1/search",
            params={"q": query, "type": "track", "limit": 1, "market": "TW"},
            headers={"Authorization": f"Bearer {token}"},
        )
    if r.status_code != 200:
        return None, None
    data: dict[str, Any] = r.json()
    tracks = (data.get("tracks") or {}).get("items") or []
    if not tracks:
        return None, None
    tr = tracks[0]
    track_id = tr.get("id")
    artists = tr.get("artists") or []
    artist_id = artists[0].get("id") if artists else None
    return (str(artist_id) if artist_id else None, str(track_id) if track_id else None)
