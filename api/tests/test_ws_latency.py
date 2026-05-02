"""End-to-end test for the ping/pong latency contract.

The frontend client (web/lib/ws.ts) computes round-trip latency by sending
`{event:"ping", data:{ts: Date.now()}}` and reading back `pong.data.ts`.
The server MUST echo the ts field back. This test pins that contract from the
backend side so any regression breaks loudly.
"""
import time

from fastapi.testclient import TestClient

from app.main import app


def _mk_room(client: TestClient) -> str:
    r = client.post("/api/rooms", json={"name": "latency", "rate_per_minute": 8})
    assert r.status_code == 201
    return r.json()["id"]


def test_pong_echoes_ts_field():
    """ping{ts:N} -> pong{ts:N}. Without this the client latency feature is dead."""
    client = TestClient(app)
    rid = _mk_room(client)
    with client.websocket_connect(f"/ws/rooms/{rid}") as ws:
        _ = ws.receive_json()  # snapshot
        ts = int(time.time() * 1000)
        ws.send_json({"event": "ping", "data": {"ts": ts}})
        msg = ws.receive_json()
        assert msg["event"] == "pong"
        assert msg["data"].get("ts") == ts


def test_pong_with_extra_data_is_preserved():
    """Forward-compat: extra payload fields must round-trip."""
    client = TestClient(app)
    rid = _mk_room(client)
    with client.websocket_connect(f"/ws/rooms/{rid}") as ws:
        _ = ws.receive_json()
        ws.send_json({"event": "ping", "data": {"ts": 12345, "marker": "x"}})
        msg = ws.receive_json()
        assert msg["event"] == "pong"
        assert msg["data"]["ts"] == 12345
        assert msg["data"]["marker"] == "x"


def test_client_pong_to_server_ping_does_not_break():
    """server.ping/pong is the server-initiated heartbeat (prune_stale).
    Clients reply with `{event:"pong", data:{}}`. The server must not error."""
    client = TestClient(app)
    rid = _mk_room(client)
    with client.websocket_connect(f"/ws/rooms/{rid}") as ws:
        _ = ws.receive_json()
        # Client-initiated keepalive simulating pong-to-server.ping.
        ws.send_json({"event": "pong", "data": {}})
        # Then send a real ping to confirm the connection survived.
        ws.send_json({"event": "ping", "data": {"ts": 1}})
        msg = ws.receive_json()
        assert msg["event"] == "pong"
        assert msg["data"]["ts"] == 1
