"""Pydantic schemas for request/response payloads."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


class RoomCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    rate_per_minute: float = Field(8.0, ge=0)


class Room(BaseModel):
    id: str
    name: str
    created_at: float
    timer_started_at: Optional[float] = None
    rate_per_minute: float


class RoomTimer(BaseModel):
    room_id: str
    elapsed_sec: float
    cost: float
    started_at: Optional[float]
    rate_per_minute: float


class SearchResult(BaseModel):
    video_id: str
    title: str
    channel: Optional[str] = None
    duration_sec: Optional[int] = None
    thumbnail_url: Optional[str] = None
    view_count: Optional[int] = None


class QueueAdd(BaseModel):
    video_id: str
    title: str
    duration_sec: Optional[int] = None
    thumbnail_url: Optional[str] = None
    channel: Optional[str] = None
    nickname: str = Field(..., min_length=1, max_length=32)
    user_id: Optional[str] = None
    vocal_mode: Literal["original", "instrumental"] = "original"


class QueueItem(BaseModel):
    id: int
    room_id: str
    user_id: Optional[str]
    nickname: str
    video_id: str
    title: str
    duration_sec: Optional[int]
    thumbnail_url: Optional[str]
    vocal_mode: Literal["original", "instrumental"]
    position: int
    status: Literal["queued", "playing", "done", "skipped"]
    added_at: float
    started_at: Optional[float] = None


class QueueReorder(BaseModel):
    item_ids: list[int]


class VocalModeUpdate(BaseModel):
    vocal_mode: Literal["original", "instrumental"]


class StreamInfo(BaseModel):
    video_id: str
    video_url: str
    audio_url: Optional[str] = None
    instrumental_url: Optional[str] = None
    expires_at: Optional[float] = None
    has_subs: bool = False


class LyricLine(BaseModel):
    time: float
    text: str


class LyricsResponse(BaseModel):
    video_id: str
    source: Literal["youtube", "lrclib", "fallback"]
    title: Optional[str] = None
    artist: Optional[str] = None
    lines: list[LyricLine] = []


class HealthResponse(BaseModel):
    status: str
    version: str
    demucs_available: bool
    cuda_available: bool
    simple_vocal_removal_available: bool = False
