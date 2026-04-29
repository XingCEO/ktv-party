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
    monkeypatch.setenv("KTV_ENABLE_DEMUCS", "0")
    from app import config
    # Settings is recomputed each call - no caching
    assert demucs_worker.is_demucs_available() is False
