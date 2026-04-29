"""Lyrics service: prefer YT subtitles (.vtt), fallback LRCLIB.net, then plain title."""
from __future__ import annotations

import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Optional

import httpx

from ..config import get_settings
from ..schemas import LyricLine, LyricsResponse

logger = logging.getLogger(__name__)

_VTT_TS = re.compile(
    r"(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})"
)
_TAGS = re.compile(r"<[^>]+>")


def parse_vtt(text: str) -> list[LyricLine]:
    lines: list[LyricLine] = []
    blocks = re.split(r"\n\s*\n", text.strip())
    for block in blocks:
        m = _VTT_TS.search(block)
        if not m:
            continue
        h, mi, s, ms = map(int, m.group(1, 2, 3, 4))
        start = h * 3600 + mi * 60 + s + ms / 1000.0
        # Body lines (after the timestamp line)
        body_lines = []
        for line in block.splitlines():
            if _VTT_TS.search(line) or line.startswith("WEBVTT") or not line.strip():
                continue
            body_lines.append(_TAGS.sub("", line).strip())
        text_joined = " ".join(filter(None, body_lines)).strip()
        if text_joined:
            lines.append(LyricLine(time=start, text=text_joined))
    # Deduplicate consecutive identical lines (auto-subs like to repeat)
    deduped: list[LyricLine] = []
    for ln in lines:
        if deduped and deduped[-1].text == ln.text:
            continue
        deduped.append(ln)
    return deduped


_LRC_LINE = re.compile(r"\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\](.*)")


def parse_lrc(text: str) -> list[LyricLine]:
    out: list[LyricLine] = []
    for raw in text.splitlines():
        m = _LRC_LINE.match(raw)
        if not m:
            continue
        mi = int(m.group(1))
        s = int(m.group(2))
        ms = int((m.group(3) or "0").ljust(3, "0")[:3])
        body = m.group(4).strip()
        if not body:
            continue
        out.append(LyricLine(time=mi * 60 + s + ms / 1000.0, text=body))
    return out


def _cache_key(video_id: str, title: Optional[str], artist: Optional[str]) -> str:
    base = f"{video_id}|{title or ''}|{artist or ''}"
    return hashlib.sha1(base.encode("utf-8")).hexdigest()


def _cache_path(video_id: str, title: Optional[str], artist: Optional[str]) -> Path:
    settings = get_settings()
    return settings.lyrics_dir / f"{_cache_key(video_id, title, artist)}.json"


async def _fetch_lrclib(title: str, artist: Optional[str]) -> Optional[str]:
    params = {"track_name": title}
    if artist:
        params["artist_name"] = artist
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get("https://lrclib.net/api/get", params=params)
        if r.status_code != 200:
            return None
        data = r.json()
        return data.get("syncedLyrics") or data.get("plainLyrics")
    except Exception as exc:  # pragma: no cover
        logger.warning("lrclib fetch failed: %s", exc)
        return None


async def get_lyrics(
    video_id: str,
    title: Optional[str] = None,
    artist: Optional[str] = None,
    vtt_path: Optional[str] = None,
) -> LyricsResponse:
    cache = _cache_path(video_id, title, artist)
    if cache.exists():
        try:
            data = json.loads(cache.read_text(encoding="utf-8"))
            return LyricsResponse(**data)
        except Exception:
            cache.unlink(missing_ok=True)

    # 1. YT subtitle (.vtt)
    if vtt_path and Path(vtt_path).exists():
        try:
            lines = parse_vtt(Path(vtt_path).read_text(encoding="utf-8", errors="ignore"))
            if lines:
                resp = LyricsResponse(
                    video_id=video_id, source="youtube", title=title, artist=artist, lines=lines
                )
                cache.write_text(resp.model_dump_json(), encoding="utf-8")
                return resp
        except Exception as exc:
            logger.warning("vtt parse failed: %s", exc)

    # 2. LRCLIB
    if title:
        text = await _fetch_lrclib(title, artist)
        if text:
            lines = parse_lrc(text)
            if lines:
                resp = LyricsResponse(
                    video_id=video_id, source="lrclib", title=title, artist=artist, lines=lines
                )
                cache.write_text(resp.model_dump_json(), encoding="utf-8")
                return resp

    # 3. Fallback
    resp = LyricsResponse(
        video_id=video_id, source="fallback", title=title, artist=artist, lines=[]
    )
    return resp
