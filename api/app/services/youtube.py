"""yt-dlp integration: search, stream URL extraction, subtitle fetch.

Designed for testability: subprocess invocation isolated in `_run_ytdlp` which
tests patch via monkeypatch. All public functions return plain dataclasses.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from ..config import get_settings

logger = logging.getLogger(__name__)

_RATE_LIMIT_LOCK = asyncio.Lock()
_LAST_CALL_TS: float = 0.0


@dataclass
class StreamInfo:
    video_id: str
    video_url: str
    audio_url: Optional[str]
    expires_at: Optional[float]
    vtt_path: Optional[str]
    title: str
    channel: Optional[str]
    duration_sec: Optional[int]


@dataclass
class SearchHit:
    video_id: str
    title: str
    channel: Optional[str]
    duration_sec: Optional[int]
    thumbnail_url: Optional[str]
    view_count: Optional[int]


def _ytdlp_executable() -> list[str]:
    exe = shutil.which("yt-dlp")
    if exe:
        return [exe]
    # Fallback: python -m yt_dlp (works with pip --user installs)
    return ["python", "-m", "yt_dlp"]


def _ffmpeg_path() -> Optional[str]:
    p = shutil.which("ffmpeg")
    if p:
        return p
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _common_args() -> list[str]:
    settings = get_settings()
    args: list[str] = ["--no-warnings", "--no-progress", "--no-color"]
    if settings.cookies_file.exists():
        args += ["--cookies", str(settings.cookies_file)]
    ff = _ffmpeg_path()
    if ff:
        args += ["--ffmpeg-location", ff]
    return args


async def _rate_limit() -> None:
    global _LAST_CALL_TS
    settings = get_settings()
    async with _RATE_LIMIT_LOCK:
        delta = time.monotonic() - _LAST_CALL_TS
        wait = settings.yt_dlp_min_interval_sec - delta
        if wait > 0:
            await asyncio.sleep(wait)
        _LAST_CALL_TS = time.monotonic()


def _run_ytdlp_sync(args: list[str], timeout: int = 60) -> str:
    cmd = _ytdlp_executable() + args
    logger.debug("ytdlp cmd: %s", cmd)
    res = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        encoding="utf-8",
        errors="replace",
    )
    if res.returncode != 0:
        raise RuntimeError(f"yt-dlp failed: {res.stderr.strip()[:500]}")
    return res.stdout


async def _run_ytdlp(args: list[str], timeout: int = 60) -> str:
    await _rate_limit()
    return await asyncio.to_thread(_run_ytdlp_sync, args, timeout)


_EXPIRE_RE = re.compile(r"[?&]expire=(\d+)")


def _parse_expires(url: str) -> Optional[float]:
    m = _EXPIRE_RE.search(url or "")
    return float(m.group(1)) if m else None


async def search(query: str, n: int = 10) -> list[SearchHit]:
    args = _common_args() + [
        "--flat-playlist",
        "--print",
        "%(.{id,title,channel,duration,thumbnail,view_count})j",
        f"ytsearch{int(n)}:{query}",
    ]
    out = await _run_ytdlp(args, timeout=45)
    hits: list[SearchHit] = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        vid = d.get("id") or ""
        # flat-playlist mode rarely populates the singular `thumbnail` field;
        # fall back to the always-available YouTube CDN URL derived from video id.
        thumb = d.get("thumbnail") or (f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg" if vid else None)
        hits.append(SearchHit(
            video_id=vid,
            title=d.get("title") or "",
            channel=d.get("channel"),
            duration_sec=int(d["duration"]) if d.get("duration") else None,
            thumbnail_url=thumb,
            view_count=int(d["view_count"]) if d.get("view_count") else None,
        ))
    return [h for h in hits if h.video_id]


async def get_stream(video_id: str) -> StreamInfo:
    """Resolve direct mp4 URL + best audio URL + write subtitles to disk."""
    settings = get_settings()
    sub_path = settings.subs_dir / f"{video_id}.vtt"

    args = _common_args() + [
        "-J",
        "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs", "zh-Hant,zh-TW,zh-Hans,zh,en",
        "--sub-format", "vtt",
        "--skip-download",
        "--paths", f"subtitle:{settings.subs_dir}",
        "--output", "%(id)s.%(ext)s",
        f"https://www.youtube.com/watch?v={video_id}",
    ]
    raw = await _run_ytdlp(args, timeout=60)
    info = json.loads(raw)

    requested = info.get("requested_formats") or []
    video_url = ""
    audio_url: Optional[str] = None
    if requested:
        for f in requested:
            if f.get("vcodec") and f.get("vcodec") != "none":
                video_url = f.get("url") or video_url
            if f.get("acodec") and f.get("acodec") != "none" and not video_url:
                audio_url = f.get("url")
            if (f.get("acodec") and f.get("acodec") != "none") and (not f.get("vcodec") or f.get("vcodec") == "none"):
                audio_url = f.get("url")
    if not video_url:
        video_url = info.get("url", "")

    expires = _parse_expires(video_url) or _parse_expires(audio_url or "")
    found_sub = sub_path if sub_path.exists() else None
    if not found_sub:
        # Try alternative naming patterns yt-dlp uses (e.g., {id}.zh-TW.vtt)
        for cand in settings.subs_dir.glob(f"{video_id}*.vtt"):
            found_sub = cand
            break

    return StreamInfo(
        video_id=video_id,
        video_url=video_url,
        audio_url=audio_url,
        expires_at=expires,
        vtt_path=str(found_sub) if found_sub else None,
        title=info.get("title", ""),
        channel=info.get("channel") or info.get("uploader"),
        duration_sec=int(info["duration"]) if info.get("duration") else None,
    )


def stream_needs_refresh(expires_at: Optional[float]) -> bool:
    if expires_at is None:
        return True
    settings = get_settings()
    return (expires_at - time.time()) < settings.stream_url_refresh_threshold_sec


async def download_mp4(video_id: str) -> Path:
    """Download MP4 to local cache for offline playback / Demucs source."""
    settings = get_settings()
    out = settings.videos_dir / f"{video_id}.mp4"
    if out.exists():
        return out
    args = _common_args() + [
        "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--merge-output-format", "mp4",
        "-o", str(out),
        f"https://www.youtube.com/watch?v={video_id}",
    ]
    await _run_ytdlp(args, timeout=300)
    return out


def cleanup_cache_lru(limit_gb: Optional[float] = None) -> int:
    """LRU eviction of cached files when total size exceeds limit. Returns bytes freed."""
    settings = get_settings()
    cap = (limit_gb if limit_gb is not None else settings.cache_size_limit_gb) * 1024**3
    files: list[tuple[Path, float, int]] = []
    for d in (settings.videos_dir, settings.instrumentals_dir):
        for p in d.glob("*"):
            if p.is_file():
                st = p.stat()
                files.append((p, st.st_atime, st.st_size))
    total = sum(s for _, _, s in files)
    if total <= cap:
        return 0
    files.sort(key=lambda x: x[1])  # oldest atime first
    freed = 0
    for path, _, size in files:
        if total - freed <= cap:
            break
        try:
            path.unlink()
            freed += size
        except OSError:
            continue
    return freed
