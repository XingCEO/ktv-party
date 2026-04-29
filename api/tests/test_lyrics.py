"""Lyrics parser unit tests."""
import pytest

from app.services import lyrics


VTT_SAMPLE = """WEBVTT

00:00:01.000 --> 00:00:04.000
第一句歌詞

00:00:04.000 --> 00:00:07.500
<c.colorE5E5E5>第二句</c> 帶標籤

00:00:07.500 --> 00:00:10.000
第二句 帶標籤
"""


def test_parse_vtt():
    out = lyrics.parse_vtt(VTT_SAMPLE)
    assert len(out) == 2  # dedupe consecutive
    assert out[0].time == 1.0
    assert out[0].text == "第一句歌詞"
    assert out[1].text == "第二句 帶標籤"


def test_parse_lrc():
    text = "[00:01.00]Hello\n[00:03.50]World\n[bad line]\n"
    out = lyrics.parse_lrc(text)
    assert len(out) == 2
    assert out[0].time == 1.0
    assert out[1].time == 3.5
    assert out[1].text == "World"


@pytest.mark.asyncio
async def test_get_lyrics_from_vtt(tmp_path, isolated_data_dir):
    vtt = tmp_path / "x.vtt"
    vtt.write_text(VTT_SAMPLE, encoding="utf-8")
    resp = await lyrics.get_lyrics("v1", title="t", artist="a", vtt_path=str(vtt))
    assert resp.source == "youtube"
    assert len(resp.lines) == 2


@pytest.mark.asyncio
async def test_get_lyrics_fallback(monkeypatch, isolated_data_dir):
    async def _no(*_a, **_kw):
        return None
    monkeypatch.setattr(lyrics, "_fetch_lrclib", _no)
    resp = await lyrics.get_lyrics("v9", title="unknown song", artist="nobody")
    assert resp.source == "fallback"
    assert resp.lines == []


def test_clean_title_strips_brackets_and_tags():
    cases = [
        ("光年之外 (Official Music Video)", "光年之外"),
        ("【MV】告白氣球", "告白氣球"),
        ("Faded [Official Audio]", "Faded"),
        ("Lemon - Kenshi Yonezu Official MV", "Lemon - Kenshi Yonezu"),
        ("Despacito (feat. Daddy Yankee)", "Despacito"),
        ("江南 Style 官方版 HD", "江南 Style"),
        # Chinese MVs use 【】 to hold the actual song name — keep it.
        ("G.E.M.【光年之外 LIGHT YEARS AWAY 】MV (電影《太空潛航者 Passengers》中文主題曲) [HD] 鄧紫棋",
         "G.E.M. 光年之外 LIGHT YEARS AWAY 鄧紫棋"),
    ]
    for raw, expected in cases:
        assert lyrics._clean_title(raw) == expected, raw


def test_title_artist_candidates_orders_artist_title_split():
    cands = lyrics._title_artist_candidates("Adele - Hello (Official Video)", None)
    titles = [t for t, _ in cands]
    artists = [a for _, a in cands]
    # Cleaned form first, then "Artist - Title" split: title=Hello artist=Adele.
    assert ("Hello", "Adele") in list(zip(titles, artists))
    # Original raw is still kept as last-resort.
    assert cands[-1][0] == "Adele - Hello (Official Video)"


def test_title_artist_candidates_dedupes():
    cands = lyrics._title_artist_candidates("Hello", "Adele")
    keys = [(t.lower(), (a or "").lower()) for t, a in cands]
    assert len(keys) == len(set(keys))


@pytest.mark.asyncio
async def test_lrclib_falls_back_to_search_when_get_misses(monkeypatch, isolated_data_dir):
    """When /api/get returns 404 for the cleaned title, /api/search should be tried."""
    calls: list[str] = []

    class FakeResp:
        def __init__(self, status: int, payload):
            self.status_code = status
            self._payload = payload
        def json(self):
            return self._payload

    class FakeClient:
        def __init__(self, *a, **kw): ...
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return None
        async def get(self, url, params=None):
            calls.append(url)
            if "/api/get" in url:
                return FakeResp(404, {})
            if "/api/search" in url:
                return FakeResp(200, [
                    {"trackName": "光年之外", "artistName": "G.E.M.",
                     "syncedLyrics": "[00:01.00]found via search"},
                ])
            return FakeResp(500, {})

    monkeypatch.setattr(lyrics.httpx, "AsyncClient", FakeClient)
    resp = await lyrics.get_lyrics("vX", title="光年之外 (Official Music Video)")
    assert resp.source == "lrclib"
    assert resp.lines and resp.lines[0].text == "found via search"
    assert any("/api/get" in c for c in calls)
    assert any("/api/search" in c for c in calls)


@pytest.mark.asyncio
async def test_lrclib_search_rejects_wrong_track(monkeypatch, isolated_data_dir):
    """Regression: lrclib /api/search returned a different song's lyrics for short
    Chinese titles ("光年之外" → unrelated track lyrics). The picker must require
    exact normalized trackName match before accepting a hit."""

    class FakeResp:
        def __init__(self, status, payload):
            self.status_code = status
            self._payload = payload
        def json(self): return self._payload

    class FakeClient:
        def __init__(self, *a, **kw): ...
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return None
        async def get(self, url, params=None):
            if "/api/get" in url:
                return FakeResp(404, {})
            if "/api/search" in url:
                return FakeResp(200, [
                    {"trackName": "光年之外的回憶", "artistName": "Someone Else",
                     "syncedLyrics": "[00:01.00]wrong song"},
                    {"trackName": "光年之外 Karaoke", "artistName": "Karaoke Star",
                     "syncedLyrics": "[00:01.00]karaoke variant"},
                ])
            return FakeResp(500, {})

    monkeypatch.setattr(lyrics.httpx, "AsyncClient", FakeClient)
    resp = await lyrics.get_lyrics("vY", title="光年之外")
    assert resp.source == "fallback"  # neither hit passed the picker
    assert resp.lines == []


@pytest.mark.asyncio
async def test_lrclib_search_accepts_substring_with_artist_match(monkeypatch, isolated_data_dir):
    """Compound YouTube titles ("G.E.M.鄧紫棋光年之外 LIGHT YEARS AWAY 大MV") must
    still find canonical lrclib trackName "光年之外" when artist matches."""

    class FakeResp:
        def __init__(self, status, payload):
            self.status_code = status
            self._payload = payload
        def json(self): return self._payload

    class FakeClient:
        def __init__(self, *a, **kw): ...
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return None
        async def get(self, url, params=None):
            if "/api/get" in url:
                return FakeResp(404, {})
            if "/api/search" in url:
                return FakeResp(200, [
                    {"trackName": "光年之外", "artistName": "G.E.M.",
                     "syncedLyrics": "[00:01.00]canonical"},
                ])
            return FakeResp(500, {})

    monkeypatch.setattr(lyrics.httpx, "AsyncClient", FakeClient)
    resp = await lyrics.get_lyrics(
        "vC",
        title="G.E.M.鄧紫棋光年之外 LIGHT YEARS AWAY 大MV",
        artist="GEM粉絲團",
    )
    assert resp.source == "lrclib"
    assert resp.lines[0].text == "canonical"


@pytest.mark.asyncio
async def test_lrclib_search_artist_filter(monkeypatch, isolated_data_dir):
    """When an artist hint is supplied, search results from a different artist
    should be rejected even if the trackName matches."""

    class FakeResp:
        def __init__(self, status, payload):
            self.status_code = status
            self._payload = payload
        def json(self): return self._payload

    class FakeClient:
        def __init__(self, *a, **kw): ...
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return None
        async def get(self, url, params=None):
            if "/api/get" in url:
                return FakeResp(404, {})
            if "/api/search" in url:
                return FakeResp(200, [
                    {"trackName": "Hello", "artistName": "Random Cover Band",
                     "syncedLyrics": "[00:01.00]wrong"},
                    {"trackName": "Hello", "artistName": "Adele",
                     "syncedLyrics": "[00:01.00]right"},
                ])
            return FakeResp(500, {})

    monkeypatch.setattr(lyrics.httpx, "AsyncClient", FakeClient)
    resp = await lyrics.get_lyrics("vZ", title="Hello", artist="Adele")
    assert resp.source == "lrclib"
    assert resp.lines[0].text == "right"
