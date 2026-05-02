"""Demucs vocal removal worker.

Strategy: queued in-process asyncio.Queue, single worker (Demucs is GPU-bound,
parallelism would thrash VRAM). Stub-friendly: tests patch `_run_demucs` and
`_check_cuda`.
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable, Optional

from ..config import get_settings
from ..db import get_conn, transaction

logger = logging.getLogger(__name__)


@dataclass
class JobStatus:
    id: str
    status: str
    error: Optional[str] = None
    instrumental_path: Optional[str] = None


def _check_cuda() -> bool:
    try:
        import torch  # type: ignore
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def is_demucs_available() -> bool:
    settings = get_settings()
    if not settings.enable_demucs:
        return False
    try:
        import demucs.separate  # type: ignore  # noqa: F401
        return True
    except Exception:
        return False


def _extract_audio_to_wav(mp4: Path, wav: Path) -> None:
    """torchaudio 2.5.x can't read MP4 video containers; extract audio first."""
    from . import youtube
    ffmpeg = youtube._ffmpeg_path()
    if not ffmpeg:
        raise RuntimeError("ffmpeg not available for audio extraction")
    wav.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg, "-y", "-i", str(mp4), "-vn", "-ac", "2", "-ar", "44100",
           "-c:a", "pcm_s16le", str(wav)]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=120,
                         encoding="utf-8", errors="replace")
    if res.returncode != 0:
        raise RuntimeError(f"ffmpeg extract failed: {res.stderr.strip()[:500]}")


def _run_demucs_sync(input_path: Path, output_dir: Path, model: str) -> Path:
    """Run demucs as subprocess for isolation. Returns path to instrumental file."""
    output_dir.mkdir(parents=True, exist_ok=True)
    # Pre-extract to WAV — torchaudio 2.5.1 doesn't decode MP4 containers and
    # the newer torchaudio (2.6+) requires torchcodec which is unreliable on
    # Windows. Decoding via ffmpeg ourselves is portable and fast.
    if input_path.suffix.lower() == ".mp4":
        wav_path = output_dir / f"{input_path.stem}.wav"
        if not wav_path.exists():
            _extract_audio_to_wav(input_path, wav_path)
        demucs_input = wav_path
    else:
        demucs_input = input_path
    cmd = [
        # Use the same interpreter that imported us so we don't accidentally
        # invoke the Windows-store "python" stub or a different env.
        sys.executable, "-m", "demucs",
        "--two-stems", "vocals",
        "-n", model,
        "-o", str(output_dir),
        "--mp3",
        str(demucs_input),
    ]
    logger.info("demucs cmd: %s", cmd)
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=900,
                         encoding="utf-8", errors="replace")
    if res.returncode != 0:
        # Surface both streams — demucs sometimes prints diagnostics to stdout.
        msg = (res.stderr or "").strip() or (res.stdout or "").strip()
        raise RuntimeError(f"demucs failed (exit {res.returncode}): {msg[-500:]}")
    # Demucs writes to {output_dir}/{model}/{stem_basename}/no_vocals.mp3
    base = input_path.stem
    cand = output_dir / model / base / "no_vocals.mp3"
    if not cand.exists():
        # Fallback: scan
        for p in output_dir.rglob("no_vocals.*"):
            cand = p
            break
    if not cand.exists():
        raise RuntimeError("demucs produced no instrumental file")
    return cand


_QUEUE: asyncio.Queue[tuple[str, str, Path, Callable[[str, JobStatus], Awaitable[None]] | None]] | None = None
_WORKER_TASK: asyncio.Task | None = None


def _ensure_queue() -> asyncio.Queue:
    global _QUEUE
    if _QUEUE is None:
        _QUEUE = asyncio.Queue(maxsize=64)
    return _QUEUE


def _job_record(job_id: str, kind: str, payload: dict, status: str = "pending") -> None:
    now = time.time()
    with transaction() as conn:
        conn.execute(
            """INSERT INTO jobs (id, kind, payload, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at""",
            (job_id, kind, json.dumps(payload, ensure_ascii=False), status, now, now),
        )


def _job_update(job_id: str, status: str, error: Optional[str] = None) -> None:
    with transaction() as conn:
        conn.execute(
            "UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?",
            (status, error, time.time(), job_id),
        )


def _song_update_instrumental(video_id: str, status: str,
                              path: Optional[str] = None,
                              error: Optional[str] = None) -> None:
    with transaction() as conn:
        conn.execute(
            """UPDATE songs SET instrumental_status = ?, instrumental_path = ?, instrumental_error = ?
               WHERE video_id = ?""",
            (status, path, error, video_id),
        )


async def _process_job(
    job_id: str,
    video_id: str,
    input_path: Path,
    on_complete: Callable[[str, JobStatus], Awaitable[None]] | None,
) -> JobStatus:
    settings = get_settings()
    out_dir = settings.instrumentals_dir / "_work"
    final_path = settings.instrumentals_dir / f"{video_id}.mp3"
    if final_path.exists():
        status = JobStatus(id=job_id, status="done", instrumental_path=str(final_path))
        _job_update(job_id, "done")
        _song_update_instrumental(video_id, "done", str(final_path))
        if on_complete:
            await on_complete(video_id, status)
        return status

    _job_update(job_id, "running")
    _song_update_instrumental(video_id, "running")
    try:
        produced = await asyncio.to_thread(
            _run_demucs_sync, input_path, out_dir, settings.demucs_model
        )
        final_path.parent.mkdir(parents=True, exist_ok=True)
        if produced.resolve() != final_path.resolve():
            shutil.copy2(produced, final_path)
        status = JobStatus(id=job_id, status="done", instrumental_path=str(final_path))
        _job_update(job_id, "done")
        _song_update_instrumental(video_id, "done", str(final_path))
    except Exception as exc:
        msg = str(exc)
        logger.exception("demucs job %s failed", job_id)
        status = JobStatus(id=job_id, status="failed", error=msg)
        _job_update(job_id, "failed", msg)
        _song_update_instrumental(video_id, "failed", error=msg)
    if on_complete:
        await on_complete(video_id, status)
    return status


async def _worker_loop() -> None:
    q = _ensure_queue()
    while True:
        try:
            while True:
                job_id, video_id, input_path, on_complete = await q.get()
                try:
                    await _process_job(job_id, video_id, input_path, on_complete)
                except Exception:
                    logger.exception("_worker_loop: unexpected error processing job %s", job_id)
                finally:
                    q.task_done()
        except Exception:
            logger.exception("_worker_loop: fatal error, restarting loop in 1s")
            await asyncio.sleep(1.0)


def start_worker(loop: asyncio.AbstractEventLoop | None = None) -> None:
    global _WORKER_TASK
    if _WORKER_TASK and not _WORKER_TASK.done():
        return
    _ensure_queue()
    _WORKER_TASK = asyncio.create_task(_worker_loop())


async def rehydrate_pending_jobs() -> None:
    """On startup, re-enqueue any jobs that were 'pending' or 'running' when
    the server died. Idempotent — safe to call multiple times."""
    from ..db import get_conn, transaction
    rows = get_conn().execute(
        "SELECT id, payload FROM jobs WHERE kind='vocal_removal' AND status IN ('pending','running')"
    ).fetchall()
    if not rows:
        return
    logger.info("rehydrating %d Demucs jobs from previous run", len(rows))
    q = _ensure_queue()
    for r in rows:
        try:
            payload = json.loads(r["payload"])
        except (json.JSONDecodeError, KeyError):
            logger.warning("skipping unrehydrateable job %s", r["id"])
            continue
        video_id = payload.get("video_id")
        # In our enqueue, it's called 'input', but the prompt uses 'input_path' string payload.get("input_path").
        # I'll check what enqueue does: {"video_id": video_id, "input": str(input_path)}
        # Wait, the prompt says `input_path_str = payload.get("input_path")` but the existing code uses "input".
        # Let me use `payload.get("input_path") or payload.get("input")` to be safe and follow the prompt but be robust.
        input_path_str = payload.get("input_path") or payload.get("input")
        if not video_id or not input_path_str:
            continue
        input_path = Path(input_path_str)
        if not input_path.exists():
            # Source file missing — mark failed.
            with transaction() as conn:
                conn.execute(
                    "UPDATE jobs SET status='failed', error='source missing on rehydrate', updated_at=? WHERE id=?",
                    (time.time(), r["id"]),
                )
            continue
        # Reset to pending and re-enqueue. on_complete is None — the original
        # callback was a closure on the prior process and is gone.
        with transaction() as conn:
            conn.execute(
                "UPDATE jobs SET status='pending', error=NULL, updated_at=? WHERE id=?",
                (time.time(), r["id"]),
            )
        try:
            q.put_nowait((r["id"], video_id, input_path, None))
        except asyncio.QueueFull:
            logger.warning("queue full during rehydrate; deferring job %s", r["id"])
            with transaction() as conn:
                conn.execute(
                    "UPDATE jobs SET status='pending', updated_at=? WHERE id=?",
                    (time.time(), r["id"]),
                )


def _ensure_worker_alive() -> None:
    """Respawn worker if it died, to ensure queue items are processed."""
    global _WORKER_TASK
    if _WORKER_TASK is None or _WORKER_TASK.done():
        logger.warning("demucs worker task is dead or missing, respawning")
        start_worker()

async def enqueue(
    video_id: str,
    input_path: Path,
    on_complete: Callable[[str, JobStatus], Awaitable[None]] | None = None,
) -> str:
    _ensure_worker_alive()
    q = _ensure_queue()
    if q.full():
        raise RuntimeError("vocal-removal queue full")
        
    job_id = uuid.uuid4().hex[:12]
    _job_record(job_id, "vocal_removal", {"video_id": video_id, "input": str(input_path)})
    _song_update_instrumental(video_id, "pending")
    
    # We already checked full(), but use put_nowait to be safe
    q.put_nowait((job_id, video_id, input_path, on_complete))
    return job_id


def get_job(job_id: str) -> Optional[JobStatus]:
    row = get_conn().execute(
        "SELECT id, status, error FROM jobs WHERE id = ?", (job_id,)
    ).fetchone()
    if not row:
        return None
    return JobStatus(id=row["id"], status=row["status"], error=row["error"])


def find_existing_instrumental(video_id: str) -> Optional[Path]:
    settings = get_settings()
    p = settings.instrumentals_dir / f"{video_id}.mp3"
    return p if p.exists() else None
