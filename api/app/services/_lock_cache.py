"""Bounded LRU cache for asyncio.Lock to prevent unbounded memory growth.

This is a hard-bound cache: under sustained pressure where every entry is
currently held, get_lock() raises rather than silently growing past maxsize.
That keeps memory predictable while preserving per-key serialization semantics
(we never hand out a *different* lock for a key that's currently held by
another caller — doing so would defeat the purpose of the cache).

The default maxsize (256) is comfortably above realistic concurrent contention
(yt-dlp downloads + ffmpeg karaoke + Demucs jobs are all bottlenecked elsewhere
to single-digit concurrency), so the raise path is reserved for genuine bugs
(stuck locks, leaked lock holders) where failing fast is the right behavior.
"""
from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict

logger = logging.getLogger(__name__)


class LockCacheFullError(RuntimeError):
    """Raised when the cache is full and every cached lock is currently held.

    This indicates either pathological concurrency or leaked lock holders.
    Callers should treat this as a transient backpressure signal — retry after
    a short delay, surface a 503 to the user, or fall back to a non-locked path.
    """


class LockCache:
    """Bounded LRU cache for per-key asyncio.Lock instances.

    - get_lock(key) returns the existing lock or creates a new one.
    - When at capacity, the oldest UNHELD entry is evicted to make room.
    - If every entry is held, raises LockCacheFullError. The dict NEVER
      exceeds `maxsize`.
    """

    def __init__(self, maxsize: int = 256) -> None:
        if maxsize < 1:
            raise ValueError("maxsize must be >= 1")
        self.maxsize = maxsize
        self._locks: OrderedDict[str, asyncio.Lock] = OrderedDict()
        self._cache_lock = asyncio.Lock()

    async def get_lock(self, key: str) -> asyncio.Lock:
        async with self._cache_lock:
            if key in self._locks:
                self._locks.move_to_end(key)
                return self._locks[key]

            if len(self._locks) >= self.maxsize:
                evict_key = None
                # OrderedDict iter is from oldest to newest.
                for k, lock in self._locks.items():
                    if not lock.locked():
                        evict_key = k
                        break
                if evict_key is None:
                    # Hard fail: every cached lock is held. Refusing to grow
                    # past maxsize is the whole point of this class.
                    logger.warning(
                        "LockCache full (maxsize=%d) and every entry is held; "
                        "refusing to insert key=%r", self.maxsize, key,
                    )
                    raise LockCacheFullError(
                        f"lock cache full ({self.maxsize}); all entries held"
                    )
                del self._locks[evict_key]

            lock = asyncio.Lock()
            self._locks[key] = lock
            return lock

    def __len__(self) -> int:
        return len(self._locks)
