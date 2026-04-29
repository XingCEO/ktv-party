"""WebSocket smoke test using TestClient."""


def test_ws_snapshot_and_atmosphere(client):
    rid = client.post("/api/rooms", json={"name": "WS"}).json()["id"]
    with client.websocket_connect(f"/ws/rooms/{rid}") as ws:
        snap = ws.receive_json()
        assert snap["event"] == "room.snapshot"
        assert snap["data"]["room"]["id"] == rid

        ws.send_json({"event": "atmosphere.confetti", "data": {"intensity": 5}})
        echoed = ws.receive_json()
        assert echoed["event"] == "atmosphere.confetti"
        assert echoed["data"]["intensity"] == 5

        ws.send_json({"event": "ping", "data": {}})
        pong = ws.receive_json()
        assert pong["event"] == "pong"


def test_ws_queue_added_event(client):
    rid = client.post("/api/rooms", json={"name": "WS2"}).json()["id"]
    with client.websocket_connect(f"/ws/rooms/{rid}") as ws:
        _ = ws.receive_json()  # snapshot
        client.post(f"/api/rooms/{rid}/queue", json={
            "video_id": "v1", "title": "t", "nickname": "alice",
        })
        evt = ws.receive_json()
        assert evt["event"] == "queue.added"
        assert evt["data"]["item"]["video_id"] == "v1"
