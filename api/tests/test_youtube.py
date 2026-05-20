"""Test yt-dlp service with subprocess mocked."""
import asyncio
import json

import pytest

from app.services import youtube


@pytest.fixture
def fake_ytdlp(monkeypatch):
    calls: list[list[str]] = []

    def _fake(args, timeout=60):
        calls.append(args)
        # Decide based on args what fake output to give.
        if any(a.startswith("ytsearch") for a in args):
            payloads = [
                {"id": "vid1", "title": "歌曲一", "channel": "C1",
                 "duration": 200, "thumbnail": "http://t/1.jpg", "view_count": 1000},
                {"id": "vid2", "title": "歌曲二", "channel": "C2",
                 "duration": 180, "thumbnail": "http://t/2.jpg", "view_count": 500},
            ]
            return "\n".join(json.dumps(p, ensure_ascii=False) for p in payloads)
        if "-J" in args:
            return json.dumps({
                "id": "vid1",
                "title": "歌曲一",
                "channel": "C1",
                "duration": 200,
                "requested_formats": [
                    {"vcodec": "avc1", "acodec": "none",
                     "url": "https://yt.example/v.mp4?expire=9999999999"},
                    {"vcodec": "none", "acodec": "mp4a",
                     "url": "https://yt.example/a.m4a?expire=9999999999"},
                ],
            })
        return "{}"

    monkeypatch.setattr(youtube, "_run_ytdlp_sync", lambda args, timeout=60: _fake(args, timeout))
    return calls


@pytest.mark.asyncio
async def test_search(fake_ytdlp):
    hits = await youtube.search("test", n=2)
    assert len(hits) == 2
    assert hits[0].video_id == "vid1"
    assert hits[0].title == "歌曲一"
    assert hits[0].duration_sec == 200


@pytest.mark.asyncio
async def test_get_stream(fake_ytdlp):
    info = await youtube.get_stream("vid1")
    assert info.video_id == "vid1"
    assert "yt.example/v.mp4" in info.video_url
    assert info.audio_url and "a.m4a" in info.audio_url
    assert info.expires_at == 9999999999.0


def test_parse_expires():
    assert youtube._parse_expires("https://x?expire=12345") == 12345.0
    assert youtube._parse_expires("https://x?other=1") is None
    assert youtube._parse_expires("") is None


def test_stream_needs_refresh():
    import time as t
    assert youtube.stream_needs_refresh(None) is True
    assert youtube.stream_needs_refresh(t.time() + 10) is True  # below threshold
    assert youtube.stream_needs_refresh(t.time() + 99999) is False


@pytest.mark.asyncio
async def test_download_mp4_dedupe_concurrent(isolated_data_dir, monkeypatch):
    call_count = 0
    vid = "dedupetest"

    # Pre-create the videos directory so download_mp4 can write the output file.
    videos_dir = isolated_data_dir / "videos"
    videos_dir.mkdir(parents=True, exist_ok=True)

    async def _fake_run_ytdlp(args, timeout=60):
        nonlocal call_count
        call_count += 1
        await asyncio.sleep(0.05)
        # Simulate yt-dlp writing the output file; find the -o argument.
        out_idx = args.index("-o")
        (videos_dir / f"{vid}.mp4").write_bytes(b"fake")

    monkeypatch.setattr(youtube, "_run_ytdlp", _fake_run_ytdlp)

    paths = await asyncio.gather(
        youtube.download_mp4(vid),
        youtube.download_mp4(vid),
    )

    assert call_count == 1, f"yt-dlp was called {call_count} times; expected 1"
    assert paths[0] == paths[1]

from app.services.youtube import (
    _classify_ytdlp_error,
    YoutubeError,
    YoutubeRateLimited,
    YoutubeGeoBlocked,
    YoutubeAgeRestricted,
    YoutubePrivate,
    YoutubeUnavailable,
)

def test_classify_ytdlp_error_buckets():
    assert isinstance(_classify_ytdlp_error("HTTP Error 429: Too Many Requests"), YoutubeRateLimited)
    assert isinstance(_classify_ytdlp_error("This video is not available in your country."), YoutubeGeoBlocked)
    assert isinstance(_classify_ytdlp_error("Sign in to confirm your age"), YoutubeAgeRestricted)
    assert isinstance(_classify_ytdlp_error("Video unavailable. This video is private."), YoutubePrivate)
    assert isinstance(_classify_ytdlp_error("This live event will begin in 3 hours."), YoutubeUnavailable)
    assert isinstance(_classify_ytdlp_error("Some random error"), YoutubeError)

def test_run_ytdlp_raises_classified_error(monkeypatch):
    import subprocess
    class FakeCompletedProcess:
        returncode = 1
        stderr = "Sign in to confirm your age"
        stdout = ""
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: FakeCompletedProcess())
    with pytest.raises(YoutubeAgeRestricted):
        youtube._run_ytdlp_sync(["--dummy"])

def test_search_endpoint_maps_youtube_error_to_429(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app

    # We must patch the async search function with an async fake
    async def _fake_search(*args, **kwargs):
        raise YoutubeRateLimited("rate limited")
    monkeypatch.setattr(youtube, "search", _fake_search)

    client = TestClient(app)
    resp = client.get("/api/search?q=test")
    assert resp.status_code == 429
    assert resp.json()["detail"]["code"] == "rate_limited"


def test_resolve_chart_returns_top_hit(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services.youtube import SearchHit

    async def _fake_search(q, n=10):
        return [
            SearchHit(
                video_id="real1",
                title="解析後的歌",
                channel="某歌手",
                duration_sec=210,
                thumbnail_url="http://t/r.jpg",
                view_count=42,
            )
        ]

    monkeypatch.setattr(youtube, "search", _fake_search)
    client = TestClient(app)
    resp = client.get("/api/charts/resolve?title=想你&artist=某歌手")
    assert resp.status_code == 200
    body = resp.json()
    assert body["video_id"] == "real1"
    assert body["duration_sec"] == 210


def test_resolve_chart_no_hit_returns_null(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app

    async def _fake_search(q, n=10):
        return []

    monkeypatch.setattr(youtube, "search", _fake_search)
    client = TestClient(app)
    resp = client.get("/api/charts/resolve?title=不存在的歌")
    assert resp.status_code == 200
    assert resp.json() is None
