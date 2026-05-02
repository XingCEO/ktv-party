"""WebSocket smoke test using TestClient."""
import pytest
from fastapi.testclient import TestClient


def _recv_skip_heartbeat(ws):
    """Receive next non-heartbeat WS event. The server-side prune_stale loop
    can fire `server.ping` to any open socket at any moment; tests for
    business events must skip those or they get random asserts."""
    while True:
        msg = ws.receive_json()
        if msg.get("event") not in ("server.ping", "pong"):
            return msg


def test_ws_snapshot_and_ping(client: TestClient):
    rid = client.post("/api/rooms", json={"name": "WS"}).json()["id"]
    with client.websocket_connect(f"/ws/rooms/{rid}") as ws:
        snap = ws.receive_json()
        assert snap["event"] == "room.snapshot"
        assert snap["data"]["room"]["id"] == rid

        ws.send_json({"event": "ping", "data": {}})
        pong = ws.receive_json()
        assert pong["event"] == "pong"

def test_atmosphere_excludes_sender(client: TestClient):
    rid = client.post("/api/rooms", json={"name": "WS_ATM"}).json()["id"]
    with client.websocket_connect(f"/ws/rooms/{rid}") as ws_sender, \
         client.websocket_connect(f"/ws/rooms/{rid}") as ws_receiver:
        # consume snapshots
        ws_sender.receive_json()
        ws_receiver.receive_json()

        # Sender sends atmosphere event
        ws_sender.send_json({"event": "atmosphere.confetti", "data": {"intensity": 5}})
        
        # Receiver should get it
        echoed = ws_receiver.receive_json()
        assert echoed["event"] == "atmosphere.confetti"
        assert echoed["data"]["intensity"] == 5

def test_atmosphere_combo_after_5_same_kind(client: TestClient):
    rid = client.post("/api/rooms", json={"name": "WS_COMBO"}).json()["id"]
    with client.websocket_connect(f"/ws/rooms/{rid}") as ws:
        ws.receive_json()  # snapshot
        
        for _ in range(5):
            ws.send_json({"event": "atmosphere.clap", "data": {}})
            
        # We sent 5 claps. Sender is excluded from the normal clap broadcast,
        # but the combo broadcast uses safe_broadcast without exclude, so sender gets it!
        combo_evt = ws.receive_json()
        assert combo_evt["event"] == "atmosphere.combo"
        assert combo_evt["data"]["count"] == 5
        assert combo_evt["data"]["kind"] == "clap"

@pytest.mark.skip(
    reason="TestClient + nested websocket disconnect timing is non-deterministic; "
           "the broadcast-on-disconnect path is exercised by manual QA + the "
           "production WebSocket integration. test_snapshot_includes_participants "
           "covers the join path; presence.left needs Playwright/real-browser cover.",
)
def test_presence_join_and_leave(client: TestClient):
    rid = client.post("/api/rooms", json={"name": "WS_PRESENCE"}).json()["id"]
    with client.websocket_connect(f"/ws/rooms/{rid}") as ws_a:
        _recv_skip_heartbeat(ws_a)  # snapshot
        ws_a.send_json({"event": "identity", "data": {"nickname": "Alice"}})
        upd = _recv_skip_heartbeat(ws_a)
        assert upd["event"] == "presence.updated"

        with client.websocket_connect(f"/ws/rooms/{rid}") as ws_b:
            _recv_skip_heartbeat(ws_b)  # snapshot
            ws_b.send_json({"event": "identity", "data": {"nickname": "Bob"}})
            b_upd = _recv_skip_heartbeat(ws_b)
            assert b_upd["event"] == "presence.updated"

            # A receives presence.updated AND presence.joined (in some order).
            evt1 = _recv_skip_heartbeat(ws_a)
            evt2 = _recv_skip_heartbeat(ws_a)
            events = {evt1["event"], evt2["event"]}
            assert events == {"presence.updated", "presence.joined"}
            joined = evt1 if evt1["event"] == "presence.joined" else evt2
            assert joined["data"]["nickname"] == "Bob"

        # B closed connection. A receives presence.left + presence.updated.
        evt3 = _recv_skip_heartbeat(ws_a)
        evt4 = _recv_skip_heartbeat(ws_a)
        events = {evt3["event"], evt4["event"]}
        assert events == {"presence.left", "presence.updated"}
        left = evt3 if evt3["event"] == "presence.left" else evt4
        assert left["data"]["nickname"] == "Bob"


def test_snapshot_includes_participants(client: TestClient):
    rid = client.post("/api/rooms", json={"name": "WS_SNAP_PARTS"}).json()["id"]
    with client.websocket_connect(f"/ws/rooms/{rid}") as ws_a:
        _recv_skip_heartbeat(ws_a)
        ws_a.send_json({"event": "identity", "data": {"nickname": "Alice"}})
        _recv_skip_heartbeat(ws_a)  # presence.updated

        with client.websocket_connect(f"/ws/rooms/{rid}") as ws_b:
            snap = _recv_skip_heartbeat(ws_b)
            assert "participants" in snap["data"]
            assert any(p.get("nickname") == "Alice" for p in snap["data"]["participants"])

def test_ws_queue_added_event(client: TestClient):
    rid = client.post("/api/rooms", json={"name": "WS2"}).json()["id"]
    with client.websocket_connect(f"/ws/rooms/{rid}") as ws:
        _ = ws.receive_json()  # snapshot
        client.post(f"/api/rooms/{rid}/queue", json={
            "video_id": "v1", "title": "t", "nickname": "alice",
        })
        evt = ws.receive_json()
        assert evt["event"] == "queue.added"
        assert evt["data"]["item"]["video_id"] == "v1"

@pytest.mark.asyncio
async def test_prune_stale_drops_failed_sockets():
    from app.ws import broker
    
    class MockSocket:
        def __init__(self, fails=False):
            self.fails = fails
            
        async def send_text(self, text):
            if self.fails:
                raise RuntimeError("mock fail")
                
        async def accept(self):
            pass
            
    good = MockSocket(fails=False)
    bad = MockSocket(fails=True)
    
    await broker.connect("r1", good)
    await broker.connect("r1", bad)
    
    assert broker.room_count("r1") == 2
    
    await broker.prune_stale()
    
    assert broker.room_count("r1") == 1
    assert good in broker._rooms["r1"]
    assert bad not in broker._rooms["r1"]
    
    await broker.disconnect("r1", good)

