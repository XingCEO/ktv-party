# AGENTS.md

This file gives repository-specific guidance to coding agents working in this
project. Keep it focused on project facts, commands, and gotchas. Do not add
machine-local runtime state or generated orchestration boilerplate here.

## Project

KTV Box is a home karaoke system for one laptop/TV plus phones on the same LAN.
It uses:

- `api/`: FastAPI, SQLite, asyncio background workers, yt-dlp, optional Demucs.
- `web/`: Next.js 14 App Router, Tailwind, Vitest, Playwright.
- `data/`: local media cache, lyrics, cookies, and SQLite DB.

Python dependencies target Python 3.11 or 3.12. Demucs/PyTorch wheels are not
available on Python 3.14; the backend should degrade gracefully when vocal
removal is unavailable.

## Common Commands

Run backend commands from `api/` and frontend commands from `web/` unless noted.

```pwsh
# Backend dev server
cd api
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Frontend dev server
cd web
npm run dev

# Start both dev servers and print LAN IPs
.\scripts\dev.ps1

# Backend tests
cd api
python -m pytest -v
python -m pytest tests/test_queue.py::test_fair_rotation -v

# Frontend tests and checks
cd web
npm run test
npm run typecheck
npm run lint
npm run build
npm run e2e

# Docker demo stack
docker compose up --build
```

## Architecture Notes

High-level flow:

```text
Phone /m/:roomId -- REST + WS --> FastAPI :8000 -- yt-dlp/Demucs/lrclib --> Internet
TV    /tv/:roomId <-- HLS/MP4 --- SQLite + asyncio worker
```

- The frontend uses same-origin REST paths through Next.js rewrites.
- WebSocket URLs are derived in `web/lib/ws.ts`; keep port assumptions in sync
  when changing dev server ports.
- Backend Pydantic schemas in `api/app/schemas.py` are mirrored by
  `web/lib/api.ts`. Update both sides together.
- WebSocket events are handled in both `api/app/main.py` and frontend consumers.
  When adding or renaming events, update backend, TV page, phone page, and tests.

## Backend Guidance

- `api/app/main.py` wires REST, WebSocket handling, scheduler startup, and worker
  lifecycle. Keep request handlers small and move reusable behavior into service
  or repository modules when it already fits an existing boundary.
- `api/app/db.py` owns the shared SQLite connection, WAL mode, foreign keys, and
  test reconnection behavior when `KTV_DB_PATH` changes.
- Do not hold `db._LOCK` across `await`. Use sync DB work inside repository
  functions or run blocking work with `asyncio.to_thread`.
- Queue state relies on both app logic and the partial unique index that allows
  only one `status='playing'` item per room.
- `api/app/queue.py::apply_fair_rotation` keeps same-singer submissions from
  monopolizing the queue while preserving FIFO order within each singer.
- yt-dlp access goes through `api/app/services/youtube.py`; tests should mock
  `_run_ytdlp` rather than touching the network.
- Demucs work goes through `api/app/services/demucs_worker.py`; tests should mock
  subprocess execution and should not require GPU or Demucs binaries.

## Frontend Guidance

- Routes:
  - `/`: create/select a room.
  - `/m/[roomId]`: phone controller.
  - `/tv/[roomId]`: TV playback surface.
- `web/lib/api.ts` is the frontend API contract. Keep it in sync with backend
  schemas.
- `web/lib/ws.ts` owns reconnect/backoff/heartbeat behavior. Avoid duplicating
  reconnect logic in pages.
- `web/lib/identity.ts` stores one local `{ user_id, nickname }` per device in
  `localStorage`; there is no auth layer.
- TV and phone pages are client-side app surfaces. Preserve responsive behavior
  for both desktop TV and mobile phone viewports.
- Reuse the existing Tailwind palette unless there is a product reason to
  change it:
  - background `#0a0a0f`
  - panel `#15151f`
  - accent `#ff4d8d`
  - gold `#ffd166`
  - mic `#06d6a0`

## Testing Expectations

- Backend tests use isolated temp data directories via `api/tests/conftest.py`.
- Network-heavy flows should be mocked in automated tests.
- Run targeted tests for changed behavior first, then the broader checks:

```pwsh
cd api
python -m pytest -q -ra

cd ..\web
npm run test
npm run typecheck
npm run lint
npm run build
npm run e2e
```

Manual QA is still required for:

- Real YouTube search/download/stream URLs.
- Real Demucs vocal separation on the target machine.
- Multi-phone same-WiFi party flow.
- LAN access through firewall/router settings.

## Local Files

Never commit runtime data or local agent state:

- `.omx/`
- `.omc/`
- `.claude/`
- `data/cookies.txt`
- generated media under `data/videos/`, `data/instrumentals/`, `data/subs/`,
  and `data/lyrics/`

## Git Notes

- Keep diffs small and reviewable.
- Do not stage unrelated local files.
- Commit messages in this repo should keep the existing Lore-style decision
  trailers when OMX hooks are active.
