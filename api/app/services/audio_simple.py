"""CPU-only vocal removal via stereo center-channel cancellation.

Most studio mixes pan vocals dead-center. Subtracting L-R on each channel
cancels content that is identical on both channels — primarily vocals, but
also some centered instruments (kick, bass, snare). The result is a thinner
but useful instrumental, and it runs in seconds on any CPU without GPU,
PyTorch, or Demucs.

Used as a fallback when `demucs_worker.is_demucs_available()` is False.
"""
from __future__ import annotations

import asyncio
import logging
import subprocess
from pathlib import Path

from ..config import get_settings
from . import youtube

logger = logging.getLogger(__name__)


def _run_ffmpeg_sync(input_path: Path, output_path: Path) -> None:
    ffmpeg = youtube._ffmpeg_path()
    if not ffmpeg:
        raise RuntimeError("ffmpeg not available")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg, "-y",
        "-i", str(input_path),
        # pan filter: c0 = L - R, c1 = R - L. The two output channels cancel
        # any mono-centered audio (vocals + kick/bass) while keeping
        # left/right-panned content (most instruments).
        "-af", "pan=stereo|c0=c0-c1|c1=c1-c0",
        "-vn",
        "-c:a", "libmp3lame", "-q:a", "4",
        str(output_path),
    ]
    logger.info("ffmpeg karaoke cmd: %s", cmd)
    res = subprocess.run(
        cmd, capture_output=True, text=True, timeout=300,
        encoding="utf-8", errors="replace",
    )
    if res.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {res.stderr.strip()[:500]}")


def is_simple_available() -> bool:
    return youtube._ffmpeg_path() is not None


async def make_karaoke(video_id: str) -> Path:
    """Produce data/instrumentals/{video_id}.mp3 via center-channel cancellation."""
    settings = get_settings()
    out = settings.instrumentals_dir / f"{video_id}.mp3"
    if out.exists():
        return out
    src = await youtube.download_mp4(video_id)
    await asyncio.to_thread(_run_ffmpeg_sync, src, out)
    return out
