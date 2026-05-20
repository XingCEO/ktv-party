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
    rate_per_minute REAL NOT NULL DEFAULT 8.0,
    skip_mode TEXT NOT NULL DEFAULT 'owner', -- owner|vote
    owner_user_id TEXT,
    theme TEXT NOT NULL DEFAULT 'cashbox-green',
    ends_at REAL
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
    instrumental_error TEXT,
    lyrics_word_timing TEXT,
    lyric_offset_sec REAL NOT NULL DEFAULT 0.0,
    intro_trim_sec REAL NOT NULL DEFAULT 0.0,
    outro_trim_sec REAL NOT NULL DEFAULT 0.0
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
    performance_mode TEXT NOT NULL DEFAULT 'solo', -- solo|duet|chorus
    duet_partner_user_id TEXT,
    duet_partner_nickname TEXT,
    dedicate_to_user_id TEXT,
    dedicate_to_nickname TEXT,
    position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', -- queued|playing|done|skipped
    added_at REAL NOT NULL,
    started_at REAL,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id) REFERENCES songs(video_id)
);

CREATE TABLE IF NOT EXISTS vote_skip (
    room_id TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (room_id, item_id, user_id)
);

CREATE TABLE IF NOT EXISTS song_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    user_id TEXT,
    nickname TEXT,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS favorite_songs (
    user_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (user_id, video_id)
);

CREATE TABLE IF NOT EXISTS device_profiles (
    user_id TEXT PRIMARY KEY,
    fingerprint TEXT,
    last_seen_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    user_id TEXT,
    nickname TEXT NOT NULL,
    message TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text', -- text|emoji
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS lyrics_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    line_time REAL,
    original_text TEXT,
    corrected_text TEXT NOT NULL,
    user_id TEXT,
    created_at REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS charts_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    chart_key TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT,
    rank_no INTEGER,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS song_metadata (
    video_id TEXT PRIMARY KEY,
    musicbrainz_artist TEXT,
    spotify_artist_id TEXT,
    spotify_track_id TEXT,
    pronunciation_json TEXT,
    updated_at REAL NOT NULL
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
            if _CONN is not None:
                try:
                    _CONN.close()
                except Exception:
                    pass
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
    try:
        conn.execute("ALTER TABLE queue_items ADD COLUMN started_at REAL")
    except sqlite3.OperationalError:
        pass  # Column already exists
    migrations = [
        ("ALTER TABLE songs ADD COLUMN lyrics_word_timing TEXT",),
        ("ALTER TABLE songs ADD COLUMN lyric_offset_sec REAL NOT NULL DEFAULT 0.0",),
        ("ALTER TABLE songs ADD COLUMN intro_trim_sec REAL NOT NULL DEFAULT 0.0",),
        ("ALTER TABLE songs ADD COLUMN outro_trim_sec REAL NOT NULL DEFAULT 0.0",),
        ("ALTER TABLE rooms ADD COLUMN skip_mode TEXT NOT NULL DEFAULT 'owner'",),
        ("ALTER TABLE rooms ADD COLUMN owner_user_id TEXT",),
        ("ALTER TABLE rooms ADD COLUMN theme TEXT NOT NULL DEFAULT 'cashbox-green'",),
        ("ALTER TABLE rooms ADD COLUMN ends_at REAL",),
        ("ALTER TABLE queue_items ADD COLUMN performance_mode TEXT NOT NULL DEFAULT 'solo'",),
        ("ALTER TABLE queue_items ADD COLUMN duet_partner_user_id TEXT",),
        ("ALTER TABLE queue_items ADD COLUMN duet_partner_nickname TEXT",),
        ("ALTER TABLE queue_items ADD COLUMN dedicate_to_user_id TEXT",),
        ("ALTER TABLE queue_items ADD COLUMN dedicate_to_nickname TEXT",),
    ]
    for (stmt,) in migrations:
        try:
            conn.execute(stmt)
        except sqlite3.OperationalError:
            pass
