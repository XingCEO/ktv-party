"""Pytest fixtures: isolated DB + settings per test."""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def isolated_data_dir(monkeypatch):
    """Each test gets its own data dir + DB; service singletons are reset."""
    tmp = Path(tempfile.mkdtemp(prefix="ktv-test-"))
    monkeypatch.setenv("KTV_DATA_DIR", str(tmp))
    monkeypatch.setenv("KTV_DB_PATH", str(tmp / "ktv.db"))
    monkeypatch.setenv("KTV_PROJECT_ROOT", str(tmp))
    monkeypatch.setenv("KTV_YTDLP_MIN_INTERVAL", "0")
    # Reset cached singletons.
    from app import config as cfg
    from app import db
    db.reset_conn_for_tests()
    yield tmp
    db.reset_conn_for_tests()
    shutil.rmtree(tmp, ignore_errors=True)


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        yield c
