"""Test yt-dlp service with subprocess mocked."""
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
