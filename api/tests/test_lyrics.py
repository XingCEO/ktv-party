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
