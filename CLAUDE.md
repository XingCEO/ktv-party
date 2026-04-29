# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

KTV Box — laptop + TV + phones home karaoke system. Single-process FastAPI backend with SQLite + an in-process Demucs worker, plus a Next.js 14 App Router frontend that serves both a TV view (`/tv/:roomId`) and a phone view (`/m/:roomId`).

Python deps for `api/` target Python 3.11/3.12 — Demucs/PyTorch wheels are unavailable on 3.14, and the system intentionally degrades gracefully (vocal removal disabled but everything else works) when the import fails.

## Common commands

Run from `api/` and `web/` respectively unless noted.

```pwsh
# Backend dev server (port 8000)
cd api; python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Frontend dev server (port 3000, binds 0.0.0.0 for LAN phone access)
cd web; npm run dev

# Both in two windows + print LAN IPs
.\scripts\dev.ps1

# Backend tests (26 tests; uses isolated tmp DB per test via conftest.py)
cd api; python -m pytest -v
cd api; python -m pytest tests/test_queue.py::test_fair_rotation -v   # single test

# Frontend tests
cd web; npm run test                  # vitest run
cd web; npm run test:watch            # vitest watch
cd web; npx vitest run tests/ws.test.ts   # single file

# Frontend type check + production build
cd web; npm run typecheck
cd web; npm run build

# E2E (optional)
cd web; npx playwright install; npm run e2e

# Lint (ruff is configured in api/pyproject.toml; web uses eslint-config-next)
cd web; npm run lint

# Docker (CPU-only Demucs by default — slow; GPU build requires editing api/Dockerfile)
docker compose up --build
```

## Architecture

### High-level data flow

```
Phone (/m/:id) ──REST + WS──▶ FastAPI :8000 ──yt-dlp / demucs / lrclib──▶ Internet
TV    (/tv/:id) ◀──HLS/MP4──── (SQLite + asyncio worker)
```

The frontend talks to the API via Next.js rewrites (`/api/:path*` → `NEXT_PUBLIC_API_BASE`, default `http://localhost:8000`), so app code uses same-origin paths. WebSocket URL is derived in `web/lib/ws.ts` by swapping the page port for `:8000` — keep that in mind if you change ports.

### Backend (`api/app/`)

- **Single asyncio process.** `main.py` wires REST + WS; lifespan starts the Demucs worker (`demucs_worker.start_worker()` registers an `asyncio.create_task` consumer of an `asyncio.Queue`). One worker only — Demucs is GPU-bound and parallel jobs would thrash VRAM.
- **SQLite via `db.py`** with WAL + foreign keys, single shared connection guarded by an `RLock`. `get_conn()` re-connects automatically when `KTV_DB_PATH` changes (this is what makes per-test isolation work — see `tests/conftest.py`). `transaction()` wraps `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`.
- **Schema** (`db.py::_SCHEMA`): `rooms`, `users`, `songs` (with cached `instrumental_status` per video_id), `queue_items`, `jobs`, `sessions`. A **partial unique index** `idx_queue_one_playing_per_room` enforces at most one `status='playing'` row per room — this is the hard guarantee behind queue state, not just app-layer logic.
- **Queue fair rotation** (`queue.py::apply_fair_rotation`): groups remaining `queued` items by `user_id` (falling back to nickname), preserves FIFO inside each group, and round-robins across groups so two phones interleave A/B/A/B. `add_to_queue` runs this after every insert. `reorder_queue` and `insert_next` bypass it for explicit user action.
- **WebSocket per room** (`ws.py::RoomBroker`): one `set[WebSocket]` per `room_id`, `safe_broadcast` swallows errors so REST handlers never break on WS failures. On connect the server sends a `room.snapshot` event with `{room, queue, current, timer}` so reconnecting clients fully resync. Atmosphere events (`atmosphere.confetti|fireworks|clap|birthday`) are echoed back to all sockets in the same room — that's how phone buttons drive the TV.
- **WS event vocabulary is duplicated** between `api/app/main.py` (server-side) and `web/lib/ws.ts` consumers (TV/phone pages). When adding events, update both sides.
- **yt-dlp wrapper** (`services/youtube.py`): all calls go through `_run_ytdlp_sync` (in `asyncio.to_thread`) with a global rate limit (`_RATE_LIMIT_LOCK`, default 2s) and optional `data/cookies.txt`. Tests monkeypatch `_run_ytdlp` to avoid network. `cleanup_cache_lru` evicts the videos+instrumentals dirs by atime when total size exceeds `KTV_CACHE_LIMIT_GB`.
- **Demucs worker** (`services/demucs_worker.py`): `enqueue()` writes a `jobs` row, sets `songs.instrumental_status='pending'`, and pushes onto an `asyncio.Queue`. The single worker invokes `python -m demucs --two-stems vocals -n htdemucs --mp3` as a subprocess via `asyncio.to_thread`. On completion it broadcasts `vocal_removal.ready` so the TV can switch the audio source mid-playback. The output is normalized to `data/instrumentals/{video_id}.mp3`. `is_demucs_available()` and `_check_cuda()` short-circuit when torch isn't importable (Python 3.14 / no GPU paths).
- **Pydantic v2 schemas** in `schemas.py` are the contract — keep `web/lib/api.ts` types in sync.

### Frontend (`web/`)

- **Next.js 14 App Router**, three routes: `/` (landing + create room), `/m/[roomId]` (phone), `/tv/[roomId]` (TV). All client-side; no server components doing data fetching.
- **`lib/api.ts`** mirrors the backend Pydantic models and exposes a typed `api.*` object. **`lib/ws.ts`** is a `RoomSocket` class with exponential reconnect backoff (1s → 15s cap) and a 25s heartbeat ping. **`lib/identity.ts`** generates `{nickname, user_id}` once and persists to `localStorage` — no auth.
- **Atmosphere effects** in `components/atmosphere/` use `framer-motion` + `canvas-confetti`, driven by WS echo events from the broker.
- **Tailwind palette** is intentional and referenced across pages: bg `#0a0a0f`, panel `#15151f`, accent `#ff4d8d`, gold `#ffd166`, mic `#06d6a0` (see `tailwind.config.js`).

### Testing

- **Backend isolation:** `tests/conftest.py::isolated_data_dir` (autouse) sets `KTV_DATA_DIR`/`KTV_DB_PATH`/`KTV_PROJECT_ROOT` to a tmp dir per test and calls `db.reset_conn_for_tests()` so the SQLite singleton reconnects. Network-bound tests (yt-dlp, Demucs subprocess) monkeypatch `_run_ytdlp` and `_run_demucs_sync` rather than running the binaries.
- **Manual-only flows** (real YouTube fetch, full Demucs E2E, multi-phone WiFi) are listed in README.md's "手動 QA Checklist" and are explicitly out of scope for automated tests.

## Environment variables

| Var | Default | Notes |
| --- | --- | --- |
| `KTV_DATA_DIR` | `./data` | All media + SQLite DB live here |
| `KTV_DB_PATH` | `$DATA/ktv.db` | Changing this triggers a reconnect on next `get_conn()` |
| `KTV_COOKIES` | `$DATA/cookies.txt` | yt-dlp cookies (Netscape format); strongly recommended |
| `KTV_ENABLE_DEMUCS` | `1` | `0` disables vocal-removal entirely |
| `KTV_DEMUCS_MODEL` | `htdemucs` | Passed to `demucs -n` |
| `KTV_YTDLP_MIN_INTERVAL` | `2.0` | Minimum seconds between yt-dlp invocations (set to `0` in tests) |
| `KTV_CACHE_LIMIT_GB` | `10` | LRU cap for videos + instrumentals |
| `KTV_CORS_ORIGINS` | `*` | Comma-separated; passed to FastAPI CORSMiddleware |
| `NEXT_PUBLIC_API_BASE` | (empty → `http://localhost:8000` in `next.config.js`) | API base for Next.js rewrites |

## Conventions and gotchas

- **Service modules use relative imports** (`from ..config import get_settings`) so test env-var overrides work without re-importing.
- **Don't hold `db._LOCK` across `await`** — use `transaction()` only inside sync functions; `await asyncio.to_thread(...)` for anything that hits sqlite + I/O.
- **WS payload shape**: every broadcast is `{event: str, data: dict}`; the snapshot on connect is the only message the server sends unprompted before any client message.
- **Stream URLs expire**: `youtube.stream_needs_refresh(expires_at)` returns `True` if the URL has < `KTV_STREAM_REFRESH_THRESHOLD_SEC` (default 600) left. Re-call `/api/songs/{id}/stream` rather than caching long-term.
- **Vocal mode switch is not synchronous**: setting `vocal_mode='instrumental'` on add or via PATCH triggers `_prewarm_instrumental` which downloads + queues Demucs in the background; the TV switches audio when `vocal_removal.ready` arrives over WS.
- **Personal/educational use only** per README — no commercial deployment, no multi-shop / multi-tenant code paths.
