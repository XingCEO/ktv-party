"""FastAPI application entry point.

Wires REST + WebSocket routes for the KTV system. All long-running operations
delegate to background tasks; HTTP handlers stay thin.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import unicodedata
from collections import deque, defaultdict
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import (
    BackgroundTasks,
    FastAPI,
    HTTPException,
    Query,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from . import queue as queue_repo
from . import rooms as rooms_repo
from .config import get_settings
from .db import get_conn, init_db
from .schemas import (
    HealthResponse,
    LyricsResponse,
    LyricOffsetUpdate,
    QueueAdd,
    QueueItem,
    QueueReorder,
    Room,
    RoomCreate,
    RoomTimer,
    SearchResult,
    StreamInfo,
    VocalModeUpdate,
)
from .services import audio_simple, demucs_worker, lyrics, youtube, scheduler, metadata
from .services.youtube import (
    YoutubeError,
    YoutubeRateLimited,
    YoutubeGeoBlocked,
    YoutubeAgeRestricted,
    YoutubePrivate,
    YoutubeUnavailable,
)
from .services._lock_cache import LockCacheFullError
from .ws import broker, safe_broadcast

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

VERSION = "0.1.0"
MAX_PLAY_SEC = 360

# (kind, ts) tuples per room, last 4s only.
_ATMOSPHERE_TRACKER: defaultdict[str, deque[tuple[str, float]]] = defaultdict(
    lambda: deque(maxlen=20)
)
COMBO_THRESHOLD = 5
COMBO_WINDOW_SEC = 4.0


def _record_atmosphere_and_check_combo(room_id: str, kind: str) -> int | None:
    """Returns combo count if threshold reached, else None."""
    now = time.time()
    tracker = _ATMOSPHERE_TRACKER[room_id]
    tracker.append((kind, now))
    # Count same-kind events within window
    same_kind_recent = sum(1 for k, t in tracker if k == kind and now - t <= COMBO_WINDOW_SEC)
    if same_kind_recent >= COMBO_THRESHOLD:
        # Burn the tracker entries for this kind so we don't fire combo every time after threshold
        tracker.clear()
        return same_kind_recent
    return None


_BG_TASKS: set[asyncio.Task] = set()


def _spawn_bg(coro) -> asyncio.Task:
    t = asyncio.create_task(coro)
    _BG_TASKS.add(t)
    t.add_done_callback(_BG_TASKS.discard)
    return t


async def _prune_ws_loop() -> None:
    while True:
        await asyncio.sleep(30.0)
        try:
            await broker.prune_stale()
        except Exception as exc:
            logger.exception("prune_stale loop error: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    demucs_worker.start_worker()
    await demucs_worker.rehydrate_pending_jobs()
    _spawn_bg(scheduler.scheduler_loop())
    _spawn_bg(_prune_ws_loop())
    logger.info("ktv-api started; demucs_available=%s", demucs_worker.is_demucs_available())
    yield
    logger.info("ktv-api shutting down")


app = FastAPI(title="KTV API", version=VERSION, lifespan=lifespan)


@app.middleware("http")
async def add_no_cache(request, call_next):
    resp = await call_next(request)
    if request.url.path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-store")
    return resp


_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_settings.cors_origins or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- health ---------------------------------------------------------
@app.get("/healthz", response_model=HealthResponse)
async def healthz() -> HealthResponse:
    return HealthResponse(
        status="ok",
        version=VERSION,
        demucs_available=demucs_worker.is_demucs_available(),
        cuda_available=demucs_worker._check_cuda(),
        simple_vocal_removal_available=audio_simple.is_simple_available(),
    )


# ---------- rooms ----------------------------------------------------------
@app.post("/api/rooms", response_model=Room, status_code=201)
async def create_room(payload: RoomCreate) -> Room:
    return rooms_repo.create_room(payload.name, payload.rate_per_minute)


@app.get("/api/rooms", response_model=list[Room])
async def list_rooms() -> list[Room]:
    return rooms_repo.list_rooms()


@app.get("/api/rooms/{room_id}", response_model=Room)
async def get_room(room_id: str) -> Room:
    room = rooms_repo.get_room(room_id)
    if not room:
        raise HTTPException(404, "room not found")
    return room


@app.delete("/api/rooms/{room_id}", status_code=204)
async def delete_room(room_id: str) -> None:
    if not rooms_repo.delete_room(room_id):
        raise HTTPException(404, "room not found")


# ---------- timer ----------------------------------------------------------
def _compute_timer(room: Room) -> RoomTimer:
    if room.timer_started_at:
        elapsed = max(0.0, time.time() - room.timer_started_at)
    else:
        elapsed = 0.0
    cost = round((elapsed / 60.0) * room.rate_per_minute, 2)
    return RoomTimer(
        room_id=room.id,
        elapsed_sec=elapsed,
        cost=cost,
        started_at=room.timer_started_at,
        rate_per_minute=room.rate_per_minute,
    )


@app.get("/api/rooms/{room_id}/timer", response_model=RoomTimer)
async def get_timer(room_id: str) -> RoomTimer:
    room = rooms_repo.get_room(room_id)
    if not room:
        raise HTTPException(404, "room not found")
    return _compute_timer(room)


@app.post("/api/rooms/{room_id}/timer", response_model=RoomTimer)
async def start_timer(room_id: str) -> RoomTimer:
    room = rooms_repo.start_timer(room_id)
    if not room:
        raise HTTPException(404, "room not found")
    timer = _compute_timer(room)
    await safe_broadcast(room_id, "room.timer.started", timer.model_dump())
    return timer


@app.delete("/api/rooms/{room_id}/timer", response_model=RoomTimer)
async def reset_timer(room_id: str) -> RoomTimer:
    room = rooms_repo.reset_timer(room_id)
    if not room:
        raise HTTPException(404, "room not found")
    timer = _compute_timer(room)
    await safe_broadcast(room_id, "room.timer.reset", timer.model_dump())
    return timer


@app.post("/api/rooms/{room_id}/ends-at", status_code=204)
async def set_room_ends_at(room_id: str, payload: dict) -> None:
    ends_at = payload.get("ends_at")
    if ends_at is not None and not isinstance(ends_at, (int, float)):
        raise HTTPException(400, "ends_at must be number or null")
    if not rooms_repo.set_ends_at(room_id, float(ends_at) if ends_at is not None else None):
        raise HTTPException(404, "room not found")
    await safe_broadcast(room_id, "room.ends_at", {"ends_at": ends_at})


@app.post("/api/rooms/{room_id}/extend", status_code=204)
async def extend_room_time(room_id: str, payload: dict) -> None:
    minutes = int(payload.get("minutes") or 0)
    if minutes <= 0:
        raise HTTPException(400, "minutes must be > 0")
    room = rooms_repo.get_room(room_id)
    if not room:
        raise HTTPException(404, "room not found")
    base = getattr(room, "ends_at", None) or time.time()
    next_ends_at = float(base) + minutes * 60
    rooms_repo.set_ends_at(room_id, next_ends_at)
    await safe_broadcast(room_id, "room.extended", {"ends_at": next_ends_at, "minutes": minutes})


# ---------- queue ----------------------------------------------------------
@app.get("/api/rooms/{room_id}/queue", response_model=list[QueueItem])
async def get_queue(room_id: str, include_done: bool = False) -> list[QueueItem]:
    if not rooms_repo.get_room(room_id):
        raise HTTPException(404, "room not found")
    return queue_repo.list_queue(room_id, include_done=include_done)


@app.post("/api/rooms/{room_id}/queue", response_model=QueueItem, status_code=201)
async def add_to_queue(room_id: str, payload: QueueAdd) -> QueueItem:
    if not rooms_repo.get_room(room_id):
        raise HTTPException(404, "room not found")
    try:
        item = queue_repo.add_to_queue(room_id, payload)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    full = queue_repo.list_queue(room_id)
    await safe_broadcast(
        room_id,
        "queue.added",
        {
            "item": item.model_dump(),
            "queue": [i.model_dump() for i in full],
        },
    )
    # Pre-warm instrumental if requested. Demucs (GPU/CPU ML) is preferred
    # when available; otherwise we fall back to ffmpeg center-channel
    # cancellation, which runs on any CPU and produces a usable karaoke track.
    if payload.vocal_mode == "instrumental" and (
        demucs_worker.is_demucs_available() or audio_simple.is_simple_available()
    ):
        _spawn_bg(_prewarm_instrumental(room_id, payload.video_id))
    # Pre-warm lyrics so the TV doesn't pay 10-30s of lrclib RTT when the song
    # actually starts. Channel was just upserted into songs table by add_to_queue.
    _spawn_bg(_prewarm_lyrics(payload.video_id, payload.title, payload.channel))
    return item


async def _prewarm_lyrics(video_id: str, title: str, channel: Optional[str]) -> None:
    try:
        await lyrics.get_lyrics(video_id, title=title, artist=channel)
    except Exception as exc:
        logger.warning("prewarm lyrics failed video_id=%s: %s", video_id, exc)


async def _prewarm_instrumental(room_id: str, video_id: str) -> None:
    try:
        existing = demucs_worker.find_existing_instrumental(video_id)
        if existing:
            await safe_broadcast(
                room_id,
                "vocal_removal.ready",
                {
                    "video_id": video_id,
                    "path": str(existing),
                },
            )
            return
        if demucs_worker.is_demucs_available():
            mp4 = await youtube.download_mp4(video_id)
            await demucs_worker.enqueue(video_id, mp4, on_complete=_on_demucs_complete(room_id))
            return
        # No Demucs — use ffmpeg center-channel cancellation. This is fast
        # enough to run inline; no queue needed.
        produced = await audio_simple.make_karaoke(video_id)
        await safe_broadcast(
            room_id,
            "vocal_removal.ready",
            {
                "video_id": video_id,
                "path": str(produced),
            },
        )
    except Exception as exc:
        logger.warning("prewarm instrumental failed video_id=%s: %s", video_id, exc)
        await safe_broadcast(
            room_id,
            "vocal_removal.failed",
            {
                "video_id": video_id,
                "error": str(exc),
            },
        )


def _on_demucs_complete(room_id: str):
    async def _cb(video_id: str, status: demucs_worker.JobStatus) -> None:
        if status.status == "done":
            await safe_broadcast(
                room_id,
                "vocal_removal.ready",
                {
                    "video_id": video_id,
                    "path": status.instrumental_path,
                },
            )
        else:
            await safe_broadcast(
                room_id,
                "vocal_removal.failed",
                {
                    "video_id": video_id,
                    "error": status.error,
                },
            )

    return _cb


@app.delete("/api/rooms/{room_id}/queue/{item_id}", status_code=204)
async def remove_queue_item(room_id: str, item_id: int) -> None:
    if not queue_repo.remove_item(room_id, item_id):
        raise HTTPException(404, "queue item not found or is currently playing")
    await safe_broadcast(
        room_id,
        "queue.removed",
        {
            "item_id": item_id,
            "queue": [i.model_dump() for i in queue_repo.list_queue(room_id)],
        },
    )


@app.patch("/api/rooms/{room_id}/queue", response_model=list[QueueItem])
async def reorder_queue(room_id: str, payload: QueueReorder) -> list[QueueItem]:
    try:
        items = queue_repo.reorder_queue(room_id, payload.item_ids)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    await safe_broadcast(
        room_id,
        "queue.reordered",
        {
            "queue": [i.model_dump() for i in items],
        },
    )
    return items


@app.post("/api/rooms/{room_id}/queue/{item_id}/insert-next", status_code=204)
async def insert_next(room_id: str, item_id: int) -> None:
    if not queue_repo.insert_next(room_id, item_id):
        raise HTTPException(404, "queue item not found")
    await safe_broadcast(
        room_id,
        "queue.reordered",
        {
            "queue": [i.model_dump() for i in queue_repo.list_queue(room_id)],
        },
    )


@app.post("/api/rooms/{room_id}/skip-mode/{mode}", status_code=204)
async def set_skip_mode(room_id: str, mode: str) -> None:
    if mode not in {"owner", "vote"}:
        raise HTTPException(400, "invalid mode")
    if not rooms_repo.set_skip_mode(room_id, mode):
        raise HTTPException(404, "room not found")
    await safe_broadcast(room_id, "room.skip_mode", {"mode": mode})


@app.post("/api/rooms/{room_id}/theme/{theme}", status_code=204)
async def set_theme(room_id: str, theme: str) -> None:
    if not rooms_repo.set_theme(room_id, theme):
        raise HTTPException(404, "room not found")
    await safe_broadcast(room_id, "room.theme", {"theme": theme})


@app.patch("/api/rooms/{room_id}/queue/{item_id}/vocal-mode", status_code=204)
async def update_vocal_mode(room_id: str, item_id: int, payload: VocalModeUpdate) -> None:
    if not queue_repo.set_vocal_mode(room_id, item_id, payload.vocal_mode):
        raise HTTPException(404, "queue item not found")
    await safe_broadcast(
        room_id,
        "queue.vocal_mode.updated",
        {
            "item_id": item_id,
            "vocal_mode": payload.vocal_mode,
            "queue": [i.model_dump() for i in queue_repo.list_queue(room_id)],
        },
    )
    # Mirror add_to_queue behavior — kick off vocal removal so the singer doesn't have
    # to wait when they actually press play. Toggling back to original is a no-op.
    if payload.vocal_mode == "instrumental" and (
        demucs_worker.is_demucs_available() or audio_simple.is_simple_available()
    ):
        row = next(
            (i for i in queue_repo.list_queue(room_id, include_done=True) if i.id == item_id),
            None,
        )
        if row:
            _spawn_bg(_prewarm_instrumental(room_id, row.video_id))


@app.post("/api/rooms/{room_id}/playback/next", response_model=Optional[QueueItem])
async def playback_next(room_id: str) -> Optional[QueueItem]:
    return await _advance_via_endpoint(room_id)


async def _advance_via_endpoint(room_id: str) -> Optional[QueueItem]:
    item = queue_repo.advance_to_next(room_id)
    full = queue_repo.list_queue(room_id)
    next_starts_at = None
    if item and item.duration_sec:
        next_starts_at = time.time() + item.duration_sec
    await safe_broadcast(
        room_id,
        "playback.advanced",
        {
            "current": item.model_dump() if item else None,
            "queue": [i.model_dump() for i in full],
            "next_starts_at": next_starts_at,
            "reason": "endpoint",
        },
    )
    return item


# ---------- search / stream / lyrics --------------------------------------
@app.get("/api/search", response_model=list[SearchResult])
async def search(
    q: str = Query(..., min_length=1), n: int = Query(10, ge=1, le=25)
) -> list[SearchResult]:
    try:
        hits = await youtube.search(q, n=n)
    except YoutubeRateLimited as exc:
        raise HTTPException(429, {"code": exc.code, "message": exc.user_message})
    except (YoutubeGeoBlocked, YoutubeAgeRestricted, YoutubePrivate) as exc:
        raise HTTPException(403, {"code": exc.code, "message": exc.user_message})
    except YoutubeUnavailable as exc:
        raise HTTPException(404, {"code": exc.code, "message": exc.user_message})
    except YoutubeError as exc:
        raise HTTPException(502, {"code": exc.code, "message": exc.user_message})
    except Exception as exc:
        raise HTTPException(502, f"search failed: {exc}")
    return [SearchResult(**h.__dict__) for h in hits]


@app.get("/api/songs/{video_id}/stream", response_model=StreamInfo)
async def get_stream(video_id: str) -> StreamInfo:
    try:
        info = await youtube.get_stream(video_id)
    except YoutubeRateLimited as exc:
        raise HTTPException(429, {"code": exc.code, "message": exc.user_message})
    except (YoutubeGeoBlocked, YoutubeAgeRestricted, YoutubePrivate) as exc:
        raise HTTPException(403, {"code": exc.code, "message": exc.user_message})
    except YoutubeUnavailable as exc:
        raise HTTPException(404, {"code": exc.code, "message": exc.user_message})
    except YoutubeError as exc:
        raise HTTPException(502, {"code": exc.code, "message": exc.user_message})
    except Exception as exc:
        raise HTTPException(502, f"stream resolve failed: {exc}")
    instrumental = demucs_worker.find_existing_instrumental(video_id)
    row = (
        get_conn()
        .execute(
            "SELECT intro_trim_sec, outro_trim_sec FROM songs WHERE video_id = ?",
            (video_id,),
        )
        .fetchone()
    )
    return StreamInfo(
        video_id=video_id,
        video_url=info.video_url,
        audio_url=info.audio_url,
        instrumental_url=f"/api/songs/{video_id}/instrumental/file" if instrumental else None,
        expires_at=info.expires_at,
        has_subs=bool(info.vtt_path),
        intro_trim_sec=float(
            row["intro_trim_sec"] if row and row["intro_trim_sec"] is not None else 0.0
        ),
        outro_trim_sec=float(
            row["outro_trim_sec"] if row and row["outro_trim_sec"] is not None else 0.0
        ),
    )


@app.post("/api/songs/{video_id}/trim-auto", status_code=204)
async def auto_trim(video_id: str, payload: dict) -> None:
    duration_sec = int(payload.get("duration_sec") or 0)
    if duration_sec <= 0:
        raise HTTPException(400, "duration_sec required")
    intro = round(min(15.0, max(0.0, duration_sec * 0.04)), 2)
    outro = round(min(18.0, max(0.0, duration_sec * 0.05)), 2)
    get_conn().execute(
        "UPDATE songs SET intro_trim_sec = ?, outro_trim_sec = ? WHERE video_id = ?",
        (intro, outro, video_id),
    )


@app.get("/api/songs/{video_id}/pronunciation")
async def pronunciation(video_id: str, lang: str = "zh") -> dict:
    row = (
        get_conn()
        .execute("SELECT lyrics_word_timing FROM songs WHERE video_id = ?", (video_id,))
        .fetchone()
    )
    words = []
    if row and row["lyrics_word_timing"]:
        try:
            words = json.loads(row["lyrics_word_timing"])
        except Exception:
            words = []
    texts = [str(w.get("text") or "") for w in words if isinstance(w, dict)]
    out: list[dict] = []
    if lang == "zh":
        try:
            from pypinyin import lazy_pinyin, Style  # type: ignore

            for i, t in enumerate(texts):
                p = " ".join(lazy_pinyin(t, style=Style.TONE3))
                out.append({"idx": i, "text": t, "anno": p})
        except Exception:
            for i, t in enumerate(texts):
                out.append({"idx": i, "text": t, "anno": ""})
    elif lang == "ja":
        try:
            from pykakasi import kakasi  # type: ignore

            kks = kakasi()
            conv = kks.convert
            for i, t in enumerate(texts):
                roma = " ".join([x.get("hepburn", "") for x in conv(t)])
                out.append({"idx": i, "text": t, "anno": roma})
        except Exception:
            for i, t in enumerate(texts):
                out.append({"idx": i, "text": t, "anno": ""})
    else:
        for i, t in enumerate(texts):
            out.append({"idx": i, "text": t, "anno": unicodedata.normalize("NFKC", t)})
    return {"video_id": video_id, "lang": lang, "items": out}


@app.get("/api/songs/{video_id}/lyrics", response_model=LyricsResponse)
async def get_lyrics(
    video_id: str,
    title: Optional[str] = None,
    artist: Optional[str] = None,
    force: bool = False,
) -> LyricsResponse:
    settings = get_settings()
    vtt = settings.subs_dir / f"{video_id}.vtt"
    vtt_path: Optional[str] = str(vtt) if vtt.exists() else None
    if not vtt_path:
        for cand in settings.subs_dir.glob(f"{video_id}*.vtt"):
            vtt_path = str(cand)
            break
    # If no artist supplied, fall back to the YouTube channel we cached on add —
    # lrclib's exact-match /api/get is a lot more reliable with an artist hint.
    if not artist:
        from .db import get_conn

        row = (
            get_conn()
            .execute(
                "SELECT channel FROM songs WHERE video_id = ?",
                (video_id,),
            )
            .fetchone()
        )
        if row and row["channel"]:
            artist = row["channel"]
    resp = await lyrics.get_lyrics(
        video_id,
        title=title,
        artist=artist,
        vtt_path=vtt_path,
        force=force,
    )
    row2 = (
        get_conn()
        .execute(
            "SELECT lyrics_word_timing, lyric_offset_sec FROM songs WHERE video_id = ?",
            (video_id,),
        )
        .fetchone()
    )
    if row2:
        if row2["lyrics_word_timing"]:
            try:
                resp.words = json.loads(row2["lyrics_word_timing"])
            except Exception:
                pass
        resp.lyric_offset_sec = float(row2["lyric_offset_sec"] or 0.0)
    if not resp.words and resp.lines:
        words: list[dict] = []
        for idx, line in enumerate(resp.lines):
            next_t = resp.lines[idx + 1].time if idx + 1 < len(resp.lines) else line.time + 3.0
            toks = [t for t in line.text.split(" ") if t]
            if not toks:
                continue
            unit = max(0.2, (next_t - line.time) / max(1, len(toks)))
            for i, tok in enumerate(toks):
                words.append(
                    {"start": line.time + i * unit, "end": line.time + (i + 1) * unit, "text": tok}
                )
        resp.words = words
        get_conn().execute(
            "UPDATE songs SET lyrics_word_timing = ? WHERE video_id = ?",
            (json.dumps(words, ensure_ascii=False), video_id),
        )
    return resp


@app.post("/api/songs/{video_id}/lyric-offset", status_code=204)
async def set_lyric_offset(video_id: str, payload: LyricOffsetUpdate) -> None:
    if payload.video_id != video_id:
        raise HTTPException(400, "video id mismatch")
    get_conn().execute(
        "UPDATE songs SET lyric_offset_sec = ? WHERE video_id = ?",
        (payload.offset_sec, video_id),
    )


@app.get("/api/users/{user_id}/history")
async def get_user_history(user_id: str) -> list[dict]:
    rows = (
        get_conn()
        .execute(
            "SELECT video_id, title, nickname, created_at FROM song_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
            (user_id,),
        )
        .fetchall()
    )
    return [dict(r) for r in rows]


@app.post("/api/users/{user_id}/favorites")
async def add_favorite(user_id: str, payload: dict) -> dict:
    video_id = str(payload.get("video_id") or "")
    title = str(payload.get("title") or "")
    if not video_id or not title:
        raise HTTPException(400, "video_id/title required")
    get_conn().execute(
        "INSERT OR REPLACE INTO favorite_songs (user_id, video_id, title, created_at) VALUES (?, ?, ?, ?)",
        (user_id, video_id, title, time.time()),
    )
    return {"ok": True}


@app.get("/api/users/{user_id}/favorites")
async def get_favorites(user_id: str) -> list[dict]:
    rows = (
        get_conn()
        .execute(
            "SELECT video_id, title, created_at FROM favorite_songs WHERE user_id = ? ORDER BY created_at DESC",
            (user_id,),
        )
        .fetchall()
    )
    return [dict(r) for r in rows]


@app.delete("/api/users/{user_id}/favorites/{video_id}", status_code=204)
async def remove_favorite(user_id: str, video_id: str) -> None:
    get_conn().execute(
        "DELETE FROM favorite_songs WHERE user_id = ? AND video_id = ?",
        (user_id, video_id),
    )


@app.get("/api/charts/local")
async def get_local_charts(period: str = "week") -> list[dict]:
    span = 7 * 86400 if period == "week" else 30 * 86400
    cutoff = time.time() - span
    rows = (
        get_conn()
        .execute(
            """SELECT video_id, title, COUNT(*) AS play_count
           FROM song_history
           WHERE created_at >= ?
           GROUP BY video_id, title
           ORDER BY play_count DESC, MAX(created_at) DESC
           LIMIT 50""",
            (cutoff,),
        )
        .fetchall()
    )
    return [dict(r) for r in rows]


@app.get("/api/artists/popular")
async def get_popular_artists(limit: int = 40) -> list[dict]:
    rows = (
        get_conn()
        .execute(
            """SELECT songs.channel AS artist, COUNT(*) AS play_count
           FROM song_history
           JOIN songs ON songs.video_id = song_history.video_id
           WHERE songs.channel IS NOT NULL AND songs.channel != ''
           GROUP BY songs.channel
           ORDER BY play_count DESC, MAX(song_history.created_at) DESC
           LIMIT ?""",
            (max(1, min(limit, 100)),),
        )
        .fetchall()
    )
    return [dict(r) for r in rows]


@app.get("/api/charts/weekly-hot")
async def get_weekly_hot(limit: int = 50) -> list[dict]:
    rows = (
        get_conn()
        .execute(
            "SELECT source, chart_key, video_id, title, artist, rank_no, created_at FROM charts_cache ORDER BY created_at DESC, rank_no ASC LIMIT ?",
            (max(1, min(limit, 200)),),
        )
        .fetchall()
    )
    return [dict(r) for r in rows]


@app.get("/api/charts/resolve", response_model=Optional[SearchResult])
async def resolve_chart(
    title: str = Query(..., min_length=1), artist: str = ""
) -> Optional[SearchResult]:
    """Resolve an external chart entry (which has no real YouTube id) to a
    playable search hit so it can be queued. Returns the top match or null."""
    q = f"{title} {artist}".strip()
    try:
        hits = await youtube.search(q, n=1)
    except YoutubeRateLimited as exc:
        raise HTTPException(429, {"code": exc.code, "message": exc.user_message})
    except (YoutubeGeoBlocked, YoutubeAgeRestricted, YoutubePrivate) as exc:
        raise HTTPException(403, {"code": exc.code, "message": exc.user_message})
    except YoutubeUnavailable as exc:
        raise HTTPException(404, {"code": exc.code, "message": exc.user_message})
    except YoutubeError as exc:
        raise HTTPException(502, {"code": exc.code, "message": exc.user_message})
    except Exception as exc:
        raise HTTPException(502, f"resolve failed: {exc}")
    if not hits:
        return None
    return SearchResult(**hits[0].__dict__)


@app.get("/api/songs/{video_id}/recommend")
async def recommend(video_id: str) -> list[dict]:
    row = (
        get_conn()
        .execute("SELECT title, channel FROM songs WHERE video_id = ?", (video_id,))
        .fetchone()
    )
    if not row:
        return []
    title = str(row["title"] or "")
    channel = str(row["channel"] or "")
    md = (
        get_conn()
        .execute(
            "SELECT musicbrainz_artist, spotify_artist_id FROM song_metadata WHERE video_id = ?",
            (video_id,),
        )
        .fetchone()
    )
    mb_artist = str(md["musicbrainz_artist"] or "") if md else ""

    cands = (
        get_conn()
        .execute(
            "SELECT video_id, title, channel, thumbnail_url, duration_sec FROM songs WHERE video_id != ? ORDER BY last_seen_at DESC LIMIT 120",
            (video_id,),
        )
        .fetchall()
    )
    scored: list[tuple[int, dict]] = []
    for r in cands:
        s = 0
        r_title = str(r["title"] or "")
        r_channel = str(r["channel"] or "")
        if channel and r_channel and channel == r_channel:
            s += 50
        tset = set(title.lower().split())
        rset = set(r_title.lower().split())
        s += min(20, len(tset & rset) * 4)
        if mb_artist and r_channel and mb_artist.lower() in r_channel.lower():
            s += 25
        scored.append((s, dict(r)))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [x[1] for x in scored[:12]]


@app.post("/api/songs/{video_id}/metadata/sync")
async def sync_song_metadata(video_id: str) -> dict:
    row = (
        get_conn()
        .execute("SELECT title, channel FROM songs WHERE video_id = ?", (video_id,))
        .fetchone()
    )
    if not row:
        raise HTTPException(404, "song not found")
    title = str(row["title"] or "")
    channel = str(row["channel"] or "") or None
    mb_artist = await metadata.fetch_musicbrainz_artist(title, channel)
    sp_artist_id, sp_track_id = await metadata.fetch_spotify_artist_id(title, channel)
    get_conn().execute(
        """INSERT INTO song_metadata (video_id, musicbrainz_artist, spotify_artist_id, spotify_track_id, pronunciation_json, updated_at)
           VALUES (?, ?, ?, ?, COALESCE((SELECT pronunciation_json FROM song_metadata WHERE video_id = ?), NULL), ?)
           ON CONFLICT(video_id) DO UPDATE SET
             musicbrainz_artist=excluded.musicbrainz_artist,
             spotify_artist_id=excluded.spotify_artist_id,
             spotify_track_id=excluded.spotify_track_id,
             updated_at=excluded.updated_at""",
        (video_id, mb_artist, sp_artist_id, sp_track_id, video_id, time.time()),
    )
    return {
        "video_id": video_id,
        "musicbrainz_artist": mb_artist,
        "spotify_artist_id": sp_artist_id,
        "spotify_track_id": sp_track_id,
    }


@app.post("/api/songs/{video_id}/lyrics-correction")
async def report_lyrics_correction(video_id: str, payload: dict) -> dict:
    get_conn().execute(
        "INSERT INTO lyrics_corrections (video_id, line_time, original_text, corrected_text, user_id, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
        (
            video_id,
            payload.get("line_time"),
            payload.get("original_text"),
            payload.get("corrected_text") or "",
            payload.get("user_id"),
            time.time(),
        ),
    )
    return {"ok": True}


@app.post("/api/songs/{video_id}/instrumental", status_code=202)
async def request_instrumental(video_id: str) -> dict:
    existing = demucs_worker.find_existing_instrumental(video_id)
    if existing:
        return {"status": "done", "video_id": video_id, "path": str(existing)}
    if demucs_worker.is_demucs_available():
        try:
            mp4 = await youtube.download_mp4(video_id)
        except LockCacheFullError:
            raise HTTPException(503, "download lock cache full, try again later")
        except YoutubeRateLimited as exc:
            raise HTTPException(429, {"code": exc.code, "message": exc.user_message})
        except (YoutubeGeoBlocked, YoutubeAgeRestricted, YoutubePrivate) as exc:
            raise HTTPException(403, {"code": exc.code, "message": exc.user_message})
        except YoutubeUnavailable as exc:
            raise HTTPException(404, {"code": exc.code, "message": exc.user_message})
        except YoutubeError as exc:
            raise HTTPException(502, {"code": exc.code, "message": exc.user_message})
        except Exception as exc:
            raise HTTPException(502, f"download failed: {exc}")
        try:
            job_id = await demucs_worker.enqueue(video_id, mp4)
        except RuntimeError as exc:
            if "queue full" in str(exc):
                raise HTTPException(503, "vocal-removal queue is full, try again later")
            raise HTTPException(502, f"demucs enqueue failed: {exc}")
        return {"status": "queued", "job_id": job_id, "video_id": video_id, "method": "demucs"}
    if audio_simple.is_simple_available():
        try:
            produced = await audio_simple.make_karaoke(video_id)
        except LockCacheFullError:
            raise HTTPException(503, "karaoke lock cache full, try again later")
        except Exception as exc:
            raise HTTPException(502, f"karaoke render failed: {exc}")
        return {
            "status": "done",
            "video_id": video_id,
            "path": str(produced),
            "method": "center_cancel",
        }
    raise HTTPException(503, "no vocal-removal backend available (need demucs or ffmpeg)")


@app.get("/api/songs/{video_id}/instrumental/file")
async def get_instrumental_file(video_id: str) -> FileResponse:
    p = demucs_worker.find_existing_instrumental(video_id)
    if not p:
        raise HTTPException(404, "instrumental not ready")
    return FileResponse(str(p), media_type="audio/mpeg", filename=f"{video_id}.mp3")


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    job = demucs_worker.get_job(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return {
        "id": job.id,
        "status": job.status,
        "error": job.error,
        "instrumental_path": job.instrumental_path,
    }


# ---------- websocket ------------------------------------------------------
@app.websocket("/ws/rooms/{room_id}")
async def ws_room(ws: WebSocket, room_id: str) -> None:
    await broker.connect(room_id, ws)
    try:
        # Initial snapshot
        room = rooms_repo.get_room(room_id)
        if room:
            current = queue_repo.get_current_playing(room_id)
            await ws.send_json(
                {
                    "event": "room.snapshot",
                    "data": {
                        "room": room.model_dump(),
                        "queue": [i.model_dump() for i in queue_repo.list_queue(room_id)],
                        "current": current.model_dump() if current else None,
                        "timer": _compute_timer(room).model_dump(),
                        "participants": broker.list_identities(room_id),
                    },
                }
            )
        while True:
            msg = await ws.receive_json()
            event = msg.get("event")
            data = msg.get("data") or {}
            # Echo simple control events as broadcasts (TV uses these for atmosphere)
            if event in {
                "atmosphere.confetti",
                "atmosphere.fireworks",
                "atmosphere.clap",
                "atmosphere.birthday",
            }:
                await safe_broadcast(room_id, event, data, exclude=ws)
                kind = event.split(".", 1)[1]
                combo = _record_atmosphere_and_check_combo(room_id, kind)
                if combo is not None:
                    await safe_broadcast(
                        room_id,
                        "atmosphere.combo",
                        {"kind": kind, "count": combo, "multiplier": min(combo // 5 + 1, 5)},
                    )
            elif event == "identity":
                await broker.set_identity(room_id, ws, data)
                room_cur = rooms_repo.get_room(room_id)
                if room_cur and not getattr(room_cur, "owner_user_id", None):
                    uid = data.get("user_id")
                    if isinstance(uid, str) and uid:
                        rooms_repo.set_owner(room_id, uid)
                await safe_broadcast(
                    room_id,
                    "presence.updated",
                    {
                        "participants": broker.list_identities(room_id),
                    },
                )
                nick = data.get("nickname")
                if nick:
                    await safe_broadcast(room_id, "presence.joined", {"nickname": nick}, exclude=ws)
            elif event == "playback.endHint":
                current = queue_repo.get_current_playing(room_id)
                if current and current.started_at and time.time() - current.started_at > 30:
                    await _advance_via_endpoint(room_id)
            elif event == "lyric.nudge":
                current = queue_repo.get_current_playing(room_id)
                item_id = data.get("item_id")
                delta_sec = data.get("delta_sec")
                if current and item_id == current.id and isinstance(delta_sec, (int, float)):
                    get_conn().execute(
                        "UPDATE songs SET lyric_offset_sec = MAX(-2.0, MIN(2.0, COALESCE(lyric_offset_sec, 0.0) + ?)) WHERE video_id = ?",
                        (float(delta_sec), current.video_id),
                    )
                    await safe_broadcast(
                        room_id,
                        "lyric.nudge",
                        {
                            "item_id": current.id,
                            "video_id": current.video_id,
                            "delta_sec": delta_sec,
                        },
                        exclude=ws,
                    )
            elif event == "skip_current":
                room_cur = rooms_repo.get_room(room_id)
                current = queue_repo.get_current_playing(room_id)
                if not room_cur or not current:
                    continue
                mode = getattr(room_cur, "skip_mode", "owner")
                requester = data.get("user_id")
                owner = getattr(room_cur, "owner_user_id", None)
                if mode == "owner":
                    if requester and requester == owner:
                        prev = current
                        item = queue_repo.skip_current(room_id)
                        queue_repo.clear_votes(room_id, prev.id)
                        if item:
                            queue_repo.save_song_history(room_id, prev)
                        await safe_broadcast(
                            room_id,
                            "playback.advanced",
                            {
                                "current": item.model_dump() if item else None,
                                "queue": [i.model_dump() for i in queue_repo.list_queue(room_id)],
                                "reason": "owner_skip",
                            },
                        )
                else:
                    uid = requester if isinstance(requester, str) else ""
                    if not uid:
                        continue
                    votes, threshold, passed = queue_repo.vote_skip(
                        room_id,
                        current.id,
                        uid,
                        len(broker.list_identities(room_id)),
                    )
                    await safe_broadcast(
                        room_id,
                        "vote_skip",
                        {
                            "item_id": current.id,
                            "votes": votes,
                            "threshold": threshold,
                            "passed": passed,
                        },
                    )
                    if passed:
                        prev = current
                        item = queue_repo.skip_current(room_id)
                        queue_repo.clear_votes(room_id, prev.id)
                        if item:
                            queue_repo.save_song_history(room_id, prev)
                        await safe_broadcast(
                            room_id,
                            "playback.advanced",
                            {
                                "current": item.model_dump() if item else None,
                                "queue": [i.model_dump() for i in queue_repo.list_queue(room_id)],
                                "reason": "vote_skip",
                            },
                        )
            elif event == "insert_top":
                item_id = data.get("item_id")
                if isinstance(item_id, int) and queue_repo.insert_next(room_id, item_id):
                    queue = queue_repo.list_queue(room_id)
                    target = next((q for q in queue if q.id == item_id), None)
                    await safe_broadcast(
                        room_id,
                        "insert_top",
                        {
                            "item_id": item_id,
                            "queue": [i.model_dump() for i in queue],
                            "message": f"{(target.nickname if target else '有人')} 插播了一首",
                        },
                    )
            elif event == "chat.send":
                nick = str(data.get("nickname") or "匿名")
                uid = data.get("user_id")
                msg_text = str(data.get("message") or "").strip()
                kind = str(data.get("kind") or "text")
                if msg_text:
                    ts = time.time()
                    get_conn().execute(
                        "INSERT INTO chat_messages (room_id, user_id, nickname, message, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                        (room_id, uid, nick, msg_text[:200], kind[:16], ts),
                    )
                    await safe_broadcast(
                        room_id,
                        "chat.message",
                        {
                            "nickname": nick,
                            "user_id": uid,
                            "message": msg_text[:200],
                            "kind": kind[:16],
                            "created_at": ts,
                        },
                    )
            elif event == "ping":
                # Echo back the ts so the client can compute round-trip latency.
                # Anything else in `data` is preserved for forward-compat.
                await ws.send_json({"event": "pong", "data": data})
            elif event == "pong":
                # Reply to a server-initiated heartbeat (server.ping). No action needed;
                # the client just proves it's still alive.
                pass
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("ws error room=%s: %s", room_id, exc)
    finally:
        identity = broker._room_identities.get(room_id, {}).get(ws)
        await broker.disconnect(room_id, ws)
        if identity:
            await safe_broadcast(room_id, "presence.left", {"nickname": identity.get("nickname")})
            await safe_broadcast(
                room_id, "presence.updated", {"participants": broker.list_identities(room_id)}
            )
