"""Lyrics service: prefer YT subtitles (.vtt), fallback LRCLIB.net, then plain title."""

from __future__ import annotations

import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Optional

import httpx

from ..config import get_settings
from ..schemas import LyricLine, LyricsResponse

logger = logging.getLogger(__name__)

try:
    from opencc import OpenCC  # type: ignore
except Exception:  # pragma: no cover
    OpenCC = None

_OPENCC = OpenCC("s2tw") if OpenCC else None

_VTT_TS = re.compile(r"(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})")
_TAGS = re.compile(r"<[^>]+>")


def parse_vtt(text: str) -> list[LyricLine]:
    lines: list[LyricLine] = []
    blocks = re.split(r"\n\s*\n", text.strip())
    for block in blocks:
        m = _VTT_TS.search(block)
        if not m:
            continue
        h, mi, s, ms = map(int, m.group(1, 2, 3, 4))
        start = h * 3600 + mi * 60 + s + ms / 1000.0
        # Body lines (after the timestamp line)
        body_lines = []
        for line in block.splitlines():
            if _VTT_TS.search(line) or line.startswith("WEBVTT") or not line.strip():
                continue
            body_lines.append(_TAGS.sub("", line).strip())
        text_joined = " ".join(filter(None, body_lines)).strip()
        if text_joined:
            lines.append(LyricLine(time=start, text=text_joined))
    # Deduplicate consecutive identical lines (auto-subs like to repeat)
    deduped: list[LyricLine] = []
    for ln in lines:
        if deduped and deduped[-1].text == ln.text:
            continue
        deduped.append(ln)
    return deduped


_LRC_LINE = re.compile(r"\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\](.*)")


def parse_lrc(text: str) -> list[LyricLine]:
    out: list[LyricLine] = []
    for raw in text.splitlines():
        m = _LRC_LINE.match(raw)
        if not m:
            continue
        mi = int(m.group(1))
        s = int(m.group(2))
        ms = int((m.group(3) or "0").ljust(3, "0")[:3])
        body = m.group(4).strip()
        if not body:
            continue
        out.append(LyricLine(time=mi * 60 + s + ms / 1000.0, text=body))
    return out


def _cache_key(video_id: str, title: Optional[str], artist: Optional[str]) -> str:
    base = f"{video_id}|{title or ''}|{artist or ''}"
    return hashlib.sha1(base.encode("utf-8")).hexdigest()


def _cache_path(video_id: str, title: Optional[str], artist: Optional[str]) -> Path:
    settings = get_settings()
    return settings.lyrics_dir / f"{_cache_key(video_id, title, artist)}.json"


# YouTube titles carry a lot of noise that lrclib's exact-match endpoint chokes on.
# Strip parentheticals/brackets and any trailing tag-words so "光年之外 (Official Music Video)"
# becomes "光年之外", and attempt to split "Artist - Title" / "Artist｜Title" patterns.
# NOTE: 【】 (Chinese black lenticular) and 《》 are NOT included — Chinese MV titles
# routinely put the actual song name inside them ("G.E.M.【光年之外】MV"). We strip
# the bracket *characters* themselves at the end of cleaning so the content survives.
_NOISE_BRACKETS = re.compile(r"[\(\[（［].*?[\)\]）］]")
_LEFTOVER_QUOTES = re.compile(r"[【】《》〈〉「」『』]")
_NOISE_TAGS = re.compile(
    r"\b("
    r"official(?:\s+(?:music|lyric|audio))?(?:\s+video)?|"
    r"music\s+video|lyric(?:s)?\s+video|"
    r"mv|m/v|hd|4k|hq|"
    r"audio|visualizer|live|cover|remix|remaster(?:ed)?|"
    r"feat\.?|ft\.?"
    r")\b",
    re.IGNORECASE,
)
# Longer alternatives must come first — Python's re module returns the first match,
# not the longest, so "官方" before "官方版" would leave "版" behind.
_NOISE_CJK = re.compile(r"(官方版|官方|完整版|現場版|歌詞版|MV版|高清|純音樂|伴奏|無損)")
_SEPARATORS = re.compile(r"\s*[\-–—｜|]\s*")


def _clean_title(raw: str) -> str:
    s = _NOISE_BRACKETS.sub(" ", raw or "")
    s = _NOISE_TAGS.sub(" ", s)
    s = _NOISE_CJK.sub(" ", s)
    # Drop leftover bracket *characters* (the inside survived because Chinese MV
    # titles use 【】《》 to wrap the actual song name). After tag-strip, things
    # like "【MV】告白氣球" collapse to " 告白氣球" — exactly what we want.
    s = _LEFTOVER_QUOTES.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip(" -–—|｜")


_INNER_BRACKETED = re.compile(r"[【《「『〈](.+?)[】》」』〉]")
_CJK_RUN = re.compile(r"[㐀-鿿]{2,}")


def _title_artist_candidates(title: str, artist: Optional[str]) -> list[tuple[str, Optional[str]]]:
    """Return (title, artist) tuples ordered by hit probability.

    Each candidate costs up to two lrclib round-trips, so order matters more
    than coverage. High-yield candidates first:
    1. Inner-bracket content with artist  ("光年之外 LIGHT YEARS AWAY" + artist)
    2. Pure-CJK runs (sorted longest first) with artist  ("光年之外", "鄧紫棋")
    3. Cleaned compound title with artist
    4. Same trio without artist
    5. Artist/title separator splits, raw title as last-resort
    """
    cleaned = _clean_title(title)
    raw = title or ""

    inner_titles: list[str] = []
    for m in _INNER_BRACKETED.findall(raw):
        s = m.strip()
        if s:
            inner_titles.append(s)

    cjk_runs: list[str] = []
    seen_runs: set[str] = set()
    for src in [cleaned, *inner_titles, raw]:
        for run in _CJK_RUN.findall(src):
            if run not in seen_runs:
                seen_runs.add(run)
                cjk_runs.append(run)
    cjk_runs.sort(key=len, reverse=True)

    cands: list[tuple[str, Optional[str]]] = []
    if artist:
        # 1. Most likely hits: inner-bracket and CJK runs WITH artist hint.
        for inner in inner_titles:
            cands.append((inner, artist))
        for run in cjk_runs:
            cands.append((run, artist))
        # 2. Cleaned (often noisy) title with artist.
        cands.append((cleaned or raw, artist))

    # 3. Same trio without artist — covers the case where the channel doesn't
    #    match lrclib's canonical artist normalization.
    for inner in inner_titles:
        cands.append((inner, None))
    for run in cjk_runs:
        cands.append((run, None))
    if cleaned and cleaned != raw:
        cands.append((cleaned, None))

    # 4. Artist/Title separator splits.
    parts = _SEPARATORS.split(cleaned, maxsplit=1) if cleaned else []
    if len(parts) == 2:
        a, b = parts[0].strip(), parts[1].strip()
        if a and b:
            cands.append((b, a))
            cands.append((a, b))

    # 5. Last-resort raw title.
    cands.append((raw, artist))

    seen = set()
    uniq: list[tuple[str, Optional[str]]] = []
    for t, a in cands:
        key = (t.lower(), (a or "").lower())
        if t and key not in seen:
            seen.add(key)
            uniq.append((t, a))
    return uniq


_NORMALIZE_PUNCT = re.compile(r"[\s\-–—_·•·\.,!?'\"\(\)\[\]【】｜|《》〈〉「」『』]+")
_BAD_VARIANT = re.compile(r"karaoke|伴奏|instrumental|純音樂|纯音乐|cover|翻唱", re.IGNORECASE)
_CJK_ONLY = re.compile(r"[㐀-鿿㐀-䶿]+")
_LATIN_ONLY = re.compile(r"[a-z0-9]+")


def _normalize_for_match(s: str) -> str:
    return _NORMALIZE_PUNCT.sub("", (s or "").lower())


def _artist_axes(s: str) -> tuple[str, str]:
    """Split a normalized artist string into (latin_part, cjk_part).

    "GEM鄧紫棋" → ("gem", "鄧紫棋"); "G.E.M. Tang" → ("gemtang", "");
    "鄧紫棋" → ("", "鄧紫棋"). Match the axes independently so different
    transliteration conventions (Pinyin vs Hanzi) don't make us reject a hit
    that's actually the same artist.
    """
    n = _normalize_for_match(s)
    latin = "".join(_LATIN_ONLY.findall(n))
    cjk = "".join(_CJK_ONLY.findall(n))
    return latin, cjk


def _artist_match(expected: Optional[str], item_artist: str) -> bool:
    if not expected:
        return False
    e_lat, e_cjk = _artist_axes(expected)
    a_lat, a_cjk = _artist_axes(item_artist)
    # Match if either axis substring-matches AND was non-empty on both sides.
    if e_lat and a_lat and (e_lat in a_lat or a_lat in e_lat):
        return True
    if e_cjk and a_cjk and (e_cjk in a_cjk or a_cjk in e_cjk):
        return True
    return False


def _pick_search_hit(
    items: list[dict], expected_title: str, expected_artist: Optional[str]
) -> Optional[str]:
    """Pick the BEST lyric body from /api/search results.

    Filtering rules:
    - Without an artist hint: trackName must normalize-equal the query.
    - With an artist hint that matches: trackName is exact OR contained in query
      (handles canonical short title inside a noisy compound).
    - Always reject obvious karaoke / instrumental / cover variants.

    Among items that pass filtering, *score* candidates and pick the highest:
    synced > plain, exact-artist-match > substring, more lines = more complete
    transcription. Without scoring we end up taking the first /api/search hit,
    which is sometimes a low-quality user upload with typos like "停留" / "法端".
    """
    expected_t = _normalize_for_match(expected_title)
    expected_a = _normalize_for_match(expected_artist or "") or None

    best: tuple[int, str] | None = None  # (score, lyrics_body)
    for item in items[:15]:
        name = item.get("trackName") or ""
        if _BAD_VARIANT.search(name):
            continue
        name_norm = _normalize_for_match(name)
        artist_name = item.get("artistName") or ""
        artist_norm = _normalize_for_match(artist_name)

        if expected_a:
            if not _artist_match(expected_artist, artist_name):
                continue
            artist_exact = artist_norm == expected_a
            # With artist confirmed, allow either-direction substring on title:
            # the canonical name might live inside our noisy query OR vice-versa
            # (lrclib often decorates trackName with pinyin/translation suffixes).
            if name_norm != expected_t and (
                not name_norm or (name_norm not in expected_t and expected_t not in name_norm)
            ):
                continue
        else:
            if name_norm != expected_t:
                continue
            artist_exact = False

        synced = item.get("syncedLyrics")
        lyr = synced or item.get("plainLyrics")
        if not lyr:
            continue

        score = 0
        if synced:
            score += 1000
        if artist_exact:
            score += 500
        if name_norm == expected_t:
            score += 200  # exact-title match beats "title contained in query"
        if _BAD_VARIANT.search(artist_name):
            score -= 300
        score += min(lyr.count("\n"), 60)  # more lines ≈ more complete; cap so it can't dominate

        if best is None or score > best[0]:
            best = (score, lyr)

    return best[1] if best else None


async def _fetch_lrclib(title: str, artist: Optional[str]) -> Optional[str]:
    async with httpx.AsyncClient(timeout=10) as client:
        for t, a in _title_artist_candidates(title, artist):
            params = {"track_name": t}
            if a:
                params["artist_name"] = a
            try:
                r = await client.get("https://lrclib.net/api/get", params=params)
            except Exception as exc:  # pragma: no cover
                logger.warning("lrclib fetch failed: %s", exc)
                continue
            if r.status_code == 200:
                data = r.json()
                lyr = data.get("syncedLyrics") or data.get("plainLyrics")
                if lyr:
                    return lyr
            # /api/search fallback — but only return a hit whose trackName
            # exactly matches our query, or we'll smear unrelated songs onto
            # short titles like "光年之外".
            try:
                r2 = await client.get("https://lrclib.net/api/search", params={"q": t})
            except Exception:  # pragma: no cover
                continue
            if r2.status_code == 200:
                items = r2.json() or []
                lyr = _pick_search_hit(items, t, a)
                if lyr:
                    return lyr
        return None


async def get_lyrics(
    video_id: str,
    title: Optional[str] = None,
    artist: Optional[str] = None,
    vtt_path: Optional[str] = None,
    force: bool = False,
) -> LyricsResponse:
    cache = _cache_path(video_id, title, artist)
    if force:
        # Also wipe any sibling cache files that share this video_id — they may
        # have been keyed under a different (title, artist) combination.
        for stale in cache.parent.glob("*.json"):
            try:
                blob = json.loads(stale.read_text(encoding="utf-8"))
                if blob.get("video_id") == video_id:
                    stale.unlink(missing_ok=True)
            except Exception:
                continue
    elif cache.exists():
        try:
            data = json.loads(cache.read_text(encoding="utf-8"))
            return LyricsResponse(**data)
        except Exception:
            cache.unlink(missing_ok=True)

    # 1. YT subtitle (.vtt)
    if vtt_path and Path(vtt_path).exists():
        try:
            lines = parse_vtt(Path(vtt_path).read_text(encoding="utf-8", errors="ignore"))
            if lines:
                if _OPENCC:
                    lines = [LyricLine(time=l.time, text=_OPENCC.convert(l.text)) for l in lines]
                resp = LyricsResponse(
                    video_id=video_id, source="youtube", title=title, artist=artist, lines=lines
                )
                cache.write_text(resp.model_dump_json(), encoding="utf-8")
                return resp
        except Exception as exc:
            logger.warning("vtt parse failed: %s", exc)

    # 2. LRCLIB
    if title:
        text = await _fetch_lrclib(title, artist)
        if text:
            lines = parse_lrc(text)
            if lines:
                if _OPENCC:
                    lines = [LyricLine(time=l.time, text=_OPENCC.convert(l.text)) for l in lines]
                resp = LyricsResponse(
                    video_id=video_id, source="lrclib", title=title, artist=artist, lines=lines
                )
                cache.write_text(resp.model_dump_json(), encoding="utf-8")
                return resp

    # 3. Fallback
    resp = LyricsResponse(
        video_id=video_id, source="fallback", title=title, artist=artist, lines=[]
    )
    return resp
