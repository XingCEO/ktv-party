"""FastAPI application entry point.

Wires REST + WebSocket routes for the KTV system. All long-running operations
delegate to background tasks; HTTP handlers stay thin.
"""
from __future__ import annotations

import asyncio
import logging
import time
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
from .db import init_db
from .schemas import (
    HealthResponse,
    LyricsResponse,
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
from .services import demucs_worker, lyrics, youtube
from .ws import broker, safe_broadcast

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

VERSION = "0.1.0"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    demucs_worker.start_worker()
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
    item = queue_repo.add_to_queue(room_id, payload)
    full = queue_repo.list_queue(room_id)
    await safe_broadcast(room_id, "queue.added", {
        "item": item.model_dump(),
        "queue": [i.model_dump() for i in full],
    })
    # Pre-warm instrumental if requested
    if payload.vocal_mode == "instrumental" and demucs_worker.is_demucs_available():
        asyncio.create_task(_prewarm_instrumental(room_id, payload.video_id))
    return item


async def _prewarm_instrumental(room_id: str, video_id: str) -> None:
    try:
        existing = demucs_worker.find_existing_instrumental(video_id)
        if existing:
            await safe_broadcast(room_id, "vocal_removal.ready", {
                "video_id": video_id, "path": str(existing),
            })
            return
        mp4 = await youtube.download_mp4(video_id)
        await demucs_worker.enqueue(video_id, mp4, on_complete=_on_demucs_complete(room_id))
    except Exception as exc:
        logger.warning("prewarm instrumental failed video_id=%s: %s", video_id, exc)


def _on_demucs_complete(room_id: str):
    async def _cb(video_id: str, status: demucs_worker.JobStatus) -> None:
        if status.status == "done":
            await safe_broadcast(room_id, "vocal_removal.ready", {
                "video_id": video_id, "path": status.instrumental_path,
            })
        else:
            await safe_broadcast(room_id, "vocal_removal.failed", {
                "video_id": video_id, "error": status.error,
            })
    return _cb


@app.delete("/api/rooms/{room_id}/queue/{item_id}", status_code=204)
async def remove_queue_item(room_id: str, item_id: int) -> None:
    if not queue_repo.remove_item(room_id, item_id):
        raise HTTPException(404, "queue item not found or is currently playing")
    await safe_broadcast(room_id, "queue.removed", {
        "item_id": item_id,
        "queue": [i.model_dump() for i in queue_repo.list_queue(room_id)],
    })


@app.patch("/api/rooms/{room_id}/queue", response_model=list[QueueItem])
async def reorder_queue(room_id: str, payload: QueueReorder) -> list[QueueItem]:
    try:
        items = queue_repo.reorder_queue(room_id, payload.item_ids)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    await safe_broadcast(room_id, "queue.reordered", {
        "queue": [i.model_dump() for i in items],
    })
    return items


@app.post("/api/rooms/{room_id}/queue/{item_id}/insert-next", status_code=204)
async def insert_next(room_id: str, item_id: int) -> None:
    if not queue_repo.insert_next(room_id, item_id):
        raise HTTPException(404, "queue item not found")
    await safe_broadcast(room_id, "queue.reordered", {
        "queue": [i.model_dump() for i in queue_repo.list_queue(room_id)],
    })


@app.patch("/api/rooms/{room_id}/queue/{item_id}/vocal-mode", status_code=204)
async def update_vocal_mode(room_id: str, item_id: int, payload: VocalModeUpdate) -> None:
    if not queue_repo.set_vocal_mode(room_id, item_id, payload.vocal_mode):
        raise HTTPException(404, "queue item not found")
    await safe_broadcast(room_id, "queue.vocal_mode.updated", {
        "item_id": item_id, "vocal_mode": payload.vocal_mode,
    })


@app.post("/api/rooms/{room_id}/playback/next", response_model=Optional[QueueItem])
async def playback_next(room_id: str) -> Optional[QueueItem]:
    item = queue_repo.advance_to_next(room_id)
    await safe_broadcast(room_id, "playback.advanced", {
        "current": item.model_dump() if item else None,
        "queue": [i.model_dump() for i in queue_repo.list_queue(room_id)],
    })
    return item


# ---------- search / stream / lyrics --------------------------------------
@app.get("/api/search", response_model=list[SearchResult])
async def search(q: str = Query(..., min_length=1), n: int = Query(10, ge=1, le=25)) -> list[SearchResult]:
    try:
        hits = await youtube.search(q, n=n)
    except Exception as exc:
        raise HTTPException(502, f"search failed: {exc}")
    return [SearchResult(**h.__dict__) for h in hits]


@app.get("/api/songs/{video_id}/stream", response_model=StreamInfo)
async def get_stream(video_id: str) -> StreamInfo:
    try:
        info = await youtube.get_stream(video_id)
    except Exception as exc:
        raise HTTPException(502, f"stream resolve failed: {exc}")
    instrumental = demucs_worker.find_existing_instrumental(video_id)
    return StreamInfo(
        video_id=video_id,
        video_url=info.video_url,
        audio_url=info.audio_url,
        instrumental_url=f"/api/songs/{video_id}/instrumental/file" if instrumental else None,
        expires_at=info.expires_at,
        has_subs=bool(info.vtt_path),
    )


@app.get("/api/songs/{video_id}/lyrics", response_model=LyricsResponse)
async def get_lyrics(
    video_id: str,
    title: Optional[str] = None,
    artist: Optional[str] = None,
) -> LyricsResponse:
    settings = get_settings()
    vtt = settings.subs_dir / f"{video_id}.vtt"
    vtt_path: Optional[str] = str(vtt) if vtt.exists() else None
    if not vtt_path:
        for cand in settings.subs_dir.glob(f"{video_id}*.vtt"):
            vtt_path = str(cand)
            break
    return await lyrics.get_lyrics(video_id, title=title, artist=artist, vtt_path=vtt_path)


@app.post("/api/songs/{video_id}/instrumental", status_code=202)
async def request_instrumental(video_id: str) -> dict:
    if not demucs_worker.is_demucs_available():
        raise HTTPException(503, "demucs not available on this server")
    existing = demucs_worker.find_existing_instrumental(video_id)
    if existing:
        return {"status": "done", "video_id": video_id, "path": str(existing)}
    try:
        mp4 = await youtube.download_mp4(video_id)
    except Exception as exc:
        raise HTTPException(502, f"download failed: {exc}")
    job_id = await demucs_worker.enqueue(video_id, mp4)
    return {"status": "queued", "job_id": job_id, "video_id": video_id}


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
            await ws.send_json({
                "event": "room.snapshot",
                "data": {
                    "room": room.model_dump(),
                    "queue": [i.model_dump() for i in queue_repo.list_queue(room_id)],
                    "current": (queue_repo.get_current_playing(room_id) or QueueItem.model_construct()).model_dump() if queue_repo.get_current_playing(room_id) else None,
                    "timer": _compute_timer(room).model_dump(),
                },
            })
        while True:
            msg = await ws.receive_json()
            event = msg.get("event")
            data = msg.get("data") or {}
            # Echo simple control events as broadcasts (TV uses these for atmosphere)
            if event in {
                "atmosphere.confetti", "atmosphere.fireworks",
                "atmosphere.clap", "atmosphere.birthday",
            }:
                await safe_broadcast(room_id, event, data)
            elif event == "ping":
                await ws.send_json({"event": "pong", "data": {}})
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("ws error room=%s: %s", room_id, exc)
    finally:
        await broker.disconnect(room_id, ws)
