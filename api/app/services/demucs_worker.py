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


def _run_demucs_sync(input_path: Path, output_dir: Path, model: str) -> Path:
    """Run demucs as subprocess for isolation. Returns path to instrumental file."""
    output_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        "python", "-m", "demucs",
        "--two-stems", "vocals",
        "-n", model,
        "-o", str(output_dir),
        "--mp3",
        str(input_path),
    ]
    logger.info("demucs cmd: %s", cmd)
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=600,
                         encoding="utf-8", errors="replace")
    if res.returncode != 0:
        raise RuntimeError(f"demucs failed: {res.stderr.strip()[:500]}")
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
        _QUEUE = asyncio.Queue()
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
        job_id, video_id, input_path, on_complete = await q.get()
        try:
            await _process_job(job_id, video_id, input_path, on_complete)
        finally:
            q.task_done()


def start_worker(loop: asyncio.AbstractEventLoop | None = None) -> None:
    global _WORKER_TASK
    if _WORKER_TASK and not _WORKER_TASK.done():
        return
    _ensure_queue()
    _WORKER_TASK = asyncio.create_task(_worker_loop())


async def enqueue(
    video_id: str,
    input_path: Path,
    on_complete: Callable[[str, JobStatus], Awaitable[None]] | None = None,
) -> str:
    job_id = uuid.uuid4().hex[:12]
    _job_record(job_id, "vocal_removal", {"video_id": video_id, "input": str(input_path)})
    _song_update_instrumental(video_id, "pending")
    q = _ensure_queue()
    await q.put((job_id, video_id, input_path, on_complete))
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
