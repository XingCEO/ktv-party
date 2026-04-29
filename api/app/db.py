"""SQLite database access layer with simple connection management."""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import get_settings

_LOCK = threading.RLock()
_SCHEMA = """
CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at REAL NOT NULL,
    timer_started_at REAL,
    rate_per_minute REAL NOT NULL DEFAULT 8.0
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    nickname TEXT NOT NULL,
    created_at REAL NOT NULL,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS songs (
    video_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    channel TEXT,
    duration_sec INTEGER,
    thumbnail_url TEXT,
    last_seen_at REAL NOT NULL,
    instrumental_path TEXT,
    instrumental_status TEXT NOT NULL DEFAULT 'none', -- none|pending|running|done|failed
    instrumental_error TEXT
);

CREATE TABLE IF NOT EXISTS queue_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    user_id TEXT,
    nickname TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    duration_sec INTEGER,
    thumbnail_url TEXT,
    vocal_mode TEXT NOT NULL DEFAULT 'original', -- original|instrumental
    position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', -- queued|playing|done|skipped
    added_at REAL NOT NULL,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES songs(video_id)
);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL, -- vocal_removal|prefetch
    payload TEXT NOT NULL, -- JSON
    status TEXT NOT NULL DEFAULT 'pending',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    error TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    started_at REAL NOT NULL,
    ended_at REAL
);

CREATE INDEX IF NOT EXISTS idx_queue_room_pos ON queue_items(room_id, position);
CREATE INDEX IF NOT EXISTS idx_queue_status ON queue_items(room_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_one_playing_per_room
    ON queue_items(room_id) WHERE status = 'playing';
"""


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    return conn


_CONN: sqlite3.Connection | None = None
_CONN_PATH: Path | None = None


def get_conn() -> sqlite3.Connection:
    global _CONN, _CONN_PATH
    settings = get_settings()
    with _LOCK:
        if _CONN is None or _CONN_PATH != settings.db_path:
            _CONN = _connect(settings.db_path)
            _CONN.executescript(_SCHEMA)
            _CONN_PATH = settings.db_path
        return _CONN


def reset_conn_for_tests() -> None:
    """Force reconnect; used by tests that swap KTV_DB_PATH."""
    global _CONN, _CONN_PATH
    with _LOCK:
        if _CONN is not None:
            try:
                _CONN.close()
            except Exception:
                pass
        _CONN = None
        _CONN_PATH = None


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    conn = get_conn()
    with _LOCK:
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise


def init_db() -> None:
    """Idempotent init for explicit startup call."""
    conn = get_conn()
    conn.executescript(_SCHEMA)
