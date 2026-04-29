import time


def test_create_list_get_delete_room(client):
    r = client.post("/api/rooms", json={"name": "包廂A", "rate_per_minute": 10})
    assert r.status_code == 201, r.text
    room = r.json()
    assert room["name"] == "包廂A"
    assert room["rate_per_minute"] == 10
    rid = room["id"]

    r = client.get("/api/rooms")
    assert r.status_code == 200
    assert any(x["id"] == rid for x in r.json())

    r = client.get(f"/api/rooms/{rid}")
    assert r.status_code == 200
    assert r.json()["id"] == rid

    r = client.delete(f"/api/rooms/{rid}")
    assert r.status_code == 204
    assert client.get(f"/api/rooms/{rid}").status_code == 404


def test_room_not_found(client):
    assert client.get("/api/rooms/zzzzzz").status_code == 404
    assert client.delete("/api/rooms/zzzzzz").status_code == 404


def test_timer_start_and_reset(client):
    rid = client.post("/api/rooms", json={"name": "T", "rate_per_minute": 60}).json()["id"]
    # Idle
    t = client.get(f"/api/rooms/{rid}/timer").json()
    assert t["elapsed_sec"] == 0
    assert t["cost"] == 0
    # Start
    t = client.post(f"/api/rooms/{rid}/timer").json()
    assert t["started_at"] is not None
    time.sleep(1.05)
    t2 = client.get(f"/api/rooms/{rid}/timer").json()
    assert t2["elapsed_sec"] >= 1.0
    # rate=60/min => 1sec ~ 1.0 cost
    assert t2["cost"] >= 0.9
    # Reset
    t3 = client.delete(f"/api/rooms/{rid}/timer").json()
    assert t3["started_at"] is None
    assert t3["elapsed_sec"] == 0


def test_timer_idempotent_start(client):
    rid = client.post("/api/rooms", json={"name": "T"}).json()["id"]
    t1 = client.post(f"/api/rooms/{rid}/timer").json()
    t2 = client.post(f"/api/rooms/{rid}/timer").json()
    assert t1["started_at"] == t2["started_at"]
