"""Application configuration loaded from environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _project_root() -> Path:
    # api/app/config.py -> api/app -> api -> project root
    return Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    project_root: Path
    data_dir: Path
    db_path: Path
    videos_dir: Path
    instrumentals_dir: Path
    subs_dir: Path
    lyrics_dir: Path
    cookies_file: Path
    yt_dlp_min_interval_sec: float
    stream_url_refresh_threshold_sec: int
    cache_size_limit_gb: float
    enable_demucs: bool
    demucs_model: str
    cors_origins: list[str]


def get_settings() -> Settings:
    root = Path(os.environ.get("KTV_PROJECT_ROOT", str(_project_root())))
    data_dir = Path(os.environ.get("KTV_DATA_DIR", str(root / "data")))
    data_dir.mkdir(parents=True, exist_ok=True)
    for sub in ("videos", "instrumentals", "subs", "lyrics"):
        (data_dir / sub).mkdir(parents=True, exist_ok=True)
    return Settings(
        project_root=root,
        data_dir=data_dir,
        db_path=Path(os.environ.get("KTV_DB_PATH", str(data_dir / "ktv.db"))),
        videos_dir=data_dir / "videos",
        instrumentals_dir=data_dir / "instrumentals",
        subs_dir=data_dir / "subs",
        lyrics_dir=data_dir / "lyrics",
        cookies_file=Path(os.environ.get("KTV_COOKIES", str(data_dir / "cookies.txt"))),
        yt_dlp_min_interval_sec=float(os.environ.get("KTV_YTDLP_MIN_INTERVAL", "2.0")),
        stream_url_refresh_threshold_sec=int(
            os.environ.get("KTV_STREAM_REFRESH_THRESHOLD_SEC", "600")
        ),
        cache_size_limit_gb=float(os.environ.get("KTV_CACHE_LIMIT_GB", "10")),
        enable_demucs=os.environ.get("KTV_ENABLE_DEMUCS", "1") not in ("0", "false", "False"),
        demucs_model=os.environ.get("KTV_DEMUCS_MODEL", "htdemucs"),
        cors_origins=[
            o.strip()
            for o in os.environ.get("KTV_CORS_ORIGINS", "*").split(",")
            if o.strip()
        ],
    )
