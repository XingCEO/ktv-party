"""Demucs worker tests with subprocess mocked."""
import asyncio
from pathlib import Path

import pytest

from app.services import demucs_worker


@pytest.mark.asyncio
async def test_enqueue_and_complete(monkeypatch, isolated_data_dir, tmp_path):
    # Fake input mp4
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")

    def _fake_run(input_path: Path, output_dir: Path, model: str) -> Path:
        out = output_dir / model / input_path.stem / "no_vocals.mp3"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"fakeaudio")
        return out

    monkeypatch.setattr(demucs_worker, "_run_demucs_sync", _fake_run)

    completed = asyncio.Event()
    result_box = {}

    async def on_done(vid, status):
        result_box["status"] = status
        completed.set()

    demucs_worker.start_worker()
    job_id = await demucs_worker.enqueue("vidX", src, on_complete=on_done)
    assert job_id

    await asyncio.wait_for(completed.wait(), timeout=10)
    status = result_box["status"]
    assert status.status == "done"
    assert status.instrumental_path
    assert Path(status.instrumental_path).exists()


def test_find_existing_instrumental(isolated_data_dir):
    from app.config import get_settings
    s = get_settings()
    p = s.instrumentals_dir / "abc.mp3"
    p.write_bytes(b"x")
    assert demucs_worker.find_existing_instrumental("abc") == p
    assert demucs_worker.find_existing_instrumental("missing") is None


def test_is_demucs_available_disabled(monkeypatch):
    """KTV_ENABLE_DEMUCS=0 must hard-disable Demucs even if the package is importable."""
    monkeypatch.setenv("KTV_ENABLE_DEMUCS", "0")
    assert demucs_worker.is_demucs_available() is False


@pytest.fixture(autouse=True)
def _reset_demucs_worker_state():
    """Each test starts with a fresh queue + worker task. Demucs worker uses
    module-level state (_QUEUE, _WORKER_TASK), and tests share the event loop
    when run together — without this the queue accumulates dummy items and
    fullness/restart tests interfere with each other.
    """
    demucs_worker._QUEUE = None
    if demucs_worker._WORKER_TASK is not None and not demucs_worker._WORKER_TASK.done():
        demucs_worker._WORKER_TASK.cancel()
    demucs_worker._WORKER_TASK = None
    yield
    if demucs_worker._WORKER_TASK is not None and not demucs_worker._WORKER_TASK.done():
        demucs_worker._WORKER_TASK.cancel()
    demucs_worker._WORKER_TASK = None
    demucs_worker._QUEUE = None


@pytest.mark.asyncio
async def test_enqueue_when_full_raises(tmp_path):
    q = demucs_worker._ensure_queue()
    while not q.full():
        q.put_nowait(("dummy_job", "vid", tmp_path / "dummy.mp4", None))

    with pytest.raises(RuntimeError, match="vocal-removal queue full"):
        await demucs_worker.enqueue("overflow", tmp_path / "dummy.mp4")


@pytest.mark.asyncio
async def test_worker_restarts_after_exception(monkeypatch, tmp_path):
    """An exception inside _process_job MUST NOT kill the worker loop —
    the next enqueued job must still get picked up.
    """
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")

    calls = []

    async def _fake_process(job_id, video_id, input_path, on_complete):
        calls.append(video_id)
        if video_id == "crash":
            raise RuntimeError("Fake crash")
        if on_complete:
            status = demucs_worker.JobStatus(id=job_id, status="done")
            await on_complete(video_id, status)
        return demucs_worker.JobStatus(id=job_id, status="done")

    monkeypatch.setattr(demucs_worker, "_process_job", _fake_process)
    demucs_worker.start_worker()

    completed = asyncio.Event()

    async def on_done(vid, status):
        completed.set()

    await demucs_worker.enqueue("crash", src)
    await asyncio.sleep(0.1)
    await demucs_worker.enqueue("healthy", src, on_complete=on_done)
    await asyncio.wait_for(completed.wait(), timeout=10)

    assert calls == ["crash", "healthy"]
    # And the worker task must still be alive (not done with an exception).
    assert demucs_worker._WORKER_TASK is not None
    assert not demucs_worker._WORKER_TASK.done()


@pytest.mark.asyncio
async def test_ensure_worker_alive_respawns_dead_worker(monkeypatch, tmp_path):
    """If the worker task dies entirely (e.g. cancelled / crashed before
    the inner try/except), enqueue() must respawn it via _ensure_worker_alive.
    """
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")

    async def _fake_process(job_id, video_id, input_path, on_complete):
        if on_complete:
            await on_complete(video_id, demucs_worker.JobStatus(id=job_id, status="done"))
        return demucs_worker.JobStatus(id=job_id, status="done")

    monkeypatch.setattr(demucs_worker, "_process_job", _fake_process)

    # Spawn a worker, then forcibly cancel it to simulate a dead worker.
    demucs_worker.start_worker()
    assert demucs_worker._WORKER_TASK is not None
    demucs_worker._WORKER_TASK.cancel()
    try:
        await demucs_worker._WORKER_TASK
    except (asyncio.CancelledError, Exception):
        pass
    assert demucs_worker._WORKER_TASK.done()

    # Now enqueue a fresh job — the wrapper must detect the dead task and respawn.
    completed = asyncio.Event()

    async def on_done(vid, status):
        completed.set()

    await demucs_worker.enqueue("after-death", src, on_complete=on_done)
    await asyncio.wait_for(completed.wait(), timeout=10)

    # The worker that processed the new job is a NEW task, not the cancelled one.
    assert demucs_worker._WORKER_TASK is not None
    assert not demucs_worker._WORKER_TASK.done()

@pytest.mark.asyncio
async def test_rehydrate_pending_jobs_re_enqueues(isolated_data_dir, tmp_path):
    from app.db import get_conn, transaction
    import json
    import time
    
    src = tmp_path / "src.mp4"
    src.write_bytes(b"fake")
    src_str = str(src)
    now = time.time()

    with transaction() as conn:
        conn.execute("INSERT INTO jobs (id, kind, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", 
                     ("job_p1", "vocal_removal", json.dumps({"video_id": "v1", "input_path": src_str}), "pending", now, now))
        conn.execute("INSERT INTO jobs (id, kind, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", 
                     ("job_p2", "vocal_removal", json.dumps({"video_id": "v2", "input": src_str}), "pending", now, now))
        conn.execute("INSERT INTO jobs (id, kind, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", 
                     ("job_r1", "vocal_removal", json.dumps({"video_id": "v3", "input_path": src_str}), "running", now, now))
        conn.execute("INSERT INTO jobs (id, kind, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", 
                     ("job_d1", "vocal_removal", json.dumps({"video_id": "v4", "input_path": src_str}), "done", now, now))

    await demucs_worker.rehydrate_pending_jobs()

    q = demucs_worker._ensure_queue()
    items = []
    while not q.empty():
        items.append(q.get_nowait())

    job_ids = {i[0] for i in items}
    assert job_ids == {"job_p1", "job_p2", "job_r1"}
    
    for jid in ["job_p1", "job_p2", "job_r1"]:
        assert demucs_worker.get_job(jid).status == "pending"

    assert demucs_worker.get_job("job_d1").status == "done"

@pytest.mark.asyncio
async def test_rehydrate_skips_missing_source(isolated_data_dir, tmp_path):
    from app.db import get_conn, transaction
    import json
    import time

    missing_src = str(tmp_path / "missing.mp4")
    now = time.time()

    with transaction() as conn:
        conn.execute("INSERT INTO jobs (id, kind, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", 
                     ("job_miss", "vocal_removal", json.dumps({"video_id": "v1", "input_path": missing_src}), "pending", now, now))

    await demucs_worker.rehydrate_pending_jobs()

    q = demucs_worker._ensure_queue()
    assert q.empty()

    job = demucs_worker.get_job("job_miss")
    assert job.status == "failed"
    assert "source missing" in job.error
