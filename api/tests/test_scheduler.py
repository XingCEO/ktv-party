import time
import pytest

from app import queue as queue_repo
from app.db import get_conn
from app.services import scheduler
from app.main import app

def _mk_room(client, name="R"):
    return client.post("/api/rooms", json={"name": name}).json()["id"]

def _add(client, rid, nick, vid, title="T", duration=100):
    return client.post(f"/api/rooms/{rid}/queue", json={
        "video_id": vid, "title": title, "nickname": nick, "duration_sec": duration
    }).json()

@pytest.mark.asyncio
async def test_scheduler_advances_overdue_song(client, monkeypatch):
    rid = _mk_room(client)
    _add(client, rid, "u1", "v1", duration=100)
    _add(client, rid, "u2", "v2", duration=100)
    
    # Fake started_at so it's overdue
    now = time.time()
    get_conn().execute("UPDATE queue_items SET started_at = ?, duration_sec = ? WHERE status = 'playing'", (now - 120, 100))
    
    await scheduler._tick()
    
    current = queue_repo.get_current_playing(rid)
    assert current is not None
    assert current.video_id == "v2"
    
@pytest.mark.asyncio
async def test_scheduler_skips_song_without_duration(client):
    rid = _mk_room(client)
    _add(client, rid, "u1", "v1", duration=None)
    _add(client, rid, "u2", "v2", duration=100)
    
    now = time.time()
    get_conn().execute("UPDATE queue_items SET started_at = ? WHERE status = 'playing'", (now - 120,))
    
    await scheduler._tick()
    
    current = queue_repo.get_current_playing(rid)
    assert current is not None
    assert current.video_id == "v1"

@pytest.mark.asyncio
async def test_scheduler_skips_song_without_started_at(client):
    rid = _mk_room(client)
    _add(client, rid, "u1", "v1", duration=100)
    _add(client, rid, "u2", "v2", duration=100)
    
    get_conn().execute("UPDATE queue_items SET started_at = NULL WHERE status = 'playing'")
    
    await scheduler._tick()
    
    current = queue_repo.get_current_playing(rid)
    assert current is not None
    assert current.video_id == "v1"

@pytest.mark.asyncio
async def test_endhint_advances_after_30s(client):
    rid = _mk_room(client)
    _add(client, rid, "u1", "v1", duration=100)
    _add(client, rid, "u2", "v2", duration=100)
    
    # Make it 31s old
    now = time.time()
    get_conn().execute("UPDATE queue_items SET started_at = ? WHERE status = 'playing'", (now - 31,))
    
    # Simulate WS call
    with client.websocket_connect(f"/ws/rooms/{rid}") as ws:
        ws.receive_json() # snapshot
        ws.send_json({"event": "playback.endHint", "data": {"item_id": 1}})
        # Check advanced
        msg = ws.receive_json()
        assert msg["event"] == "playback.advanced"
        
    current = queue_repo.get_current_playing(rid)
    assert current.video_id == "v2"

@pytest.mark.asyncio
async def test_endhint_ignored_within_30s(client):
    rid = _mk_room(client)
    _add(client, rid, "u1", "v1", duration=100)
    _add(client, rid, "u2", "v2", duration=100)
    
    # Make it 10s old
    now = time.time()
    get_conn().execute("UPDATE queue_items SET started_at = ? WHERE status = 'playing'", (now - 10,))
    
    # Simulate WS call
    with client.websocket_connect(f"/ws/rooms/{rid}") as ws:
        ws.receive_json() # snapshot
        ws.send_json({"event": "playback.endHint", "data": {"item_id": 1}})
        
    # Wait a bit to ensure it doesn't advance
    time.sleep(0.1)
    
    current = queue_repo.get_current_playing(rid)
    assert current.video_id == "v1"
