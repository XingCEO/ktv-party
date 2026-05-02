"""Tests for the bounded LockCache."""
import asyncio

import pytest

from app.services._lock_cache import LockCache, LockCacheFullError


@pytest.mark.asyncio
async def test_lock_cache_eviction():
    cache = LockCache(maxsize=3)

    l1 = await cache.get_lock("k1")  # noqa: F841
    l2 = await cache.get_lock("k2")
    l3 = await cache.get_lock("k3")  # noqa: F841

    assert len(cache) == 3
    assert list(cache._locks.keys()) == ["k1", "k2", "k3"]

    # Re-access k1 to make it most-recently-used.
    await cache.get_lock("k1")
    assert list(cache._locks.keys()) == ["k2", "k3", "k1"]

    # Hold k2 so it can't be evicted; new key must evict k3 (oldest unheld).
    async with l2:
        l4 = await cache.get_lock("k4")  # noqa: F841
        assert len(cache) == 3
        assert list(cache._locks.keys()) == ["k2", "k1", "k4"]

        # Now evict k1 (oldest unheld; k2 still held).
        l5 = await cache.get_lock("k5")  # noqa: F841
        assert len(cache) == 3
        assert list(cache._locks.keys()) == ["k2", "k4", "k5"]

    # k2 released; adding k6 evicts k2 (now oldest unheld).
    await cache.get_lock("k6")
    assert len(cache) == 3
    assert list(cache._locks.keys()) == ["k4", "k5", "k6"]


@pytest.mark.asyncio
async def test_lock_cache_held_locks_block_eviction_and_raise_when_full():
    """When every cached lock is held, the cache MUST refuse to grow past
    maxsize — otherwise the 'bounded' contract is meaningless."""
    cache = LockCache(maxsize=2)
    l1 = await cache.get_lock("k1")
    l2 = await cache.get_lock("k2")

    async with l1, l2:
        with pytest.raises(LockCacheFullError):
            await cache.get_lock("k3")
        # Size MUST stay at maxsize even after the failed insert.
        assert len(cache) == 2
        assert list(cache._locks.keys()) == ["k1", "k2"]

    # Once a lock releases, the next insert succeeds and evicts the released one.
    await cache.get_lock("k3")
    assert len(cache) == 2
    assert "k3" in cache._locks


@pytest.mark.asyncio
async def test_lock_cache_returns_same_lock_for_same_key():
    """Critical: per-key serialization requires the SAME lock instance."""
    cache = LockCache(maxsize=8)
    a = await cache.get_lock("video123")
    b = await cache.get_lock("video123")
    assert a is b


@pytest.mark.asyncio
async def test_lock_cache_concurrent_holders_actually_serialize():
    """Two concurrent callers for the same key must NOT both enter the
    critical section — proves the cache hands out a shared lock, not
    independent ones."""
    cache = LockCache(maxsize=4)
    inside = 0
    max_seen = 0

    async def worker() -> None:
        nonlocal inside, max_seen
        lock = await cache.get_lock("shared")
        async with lock:
            inside += 1
            max_seen = max(max_seen, inside)
            await asyncio.sleep(0.01)
            inside -= 1

    await asyncio.gather(*(worker() for _ in range(5)))
    assert max_seen == 1


def test_lock_cache_rejects_invalid_maxsize():
    with pytest.raises(ValueError):
        LockCache(maxsize=0)
