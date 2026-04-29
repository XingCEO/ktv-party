import pytest


def _mk_room(client, name="R"):
    return client.post("/api/rooms", json={"name": name}).json()["id"]


def _add(client, rid, nick, vid, title="T"):
    return client.post(f"/api/rooms/{rid}/queue", json={
        "video_id": vid, "title": title, "nickname": nick,
    }).json()


def test_add_and_list_queue(client):
    rid = _mk_room(client)
    item = _add(client, rid, "alice", "v1")
    assert item["nickname"] == "alice"
    assert item["video_id"] == "v1"
    # First add: fair-rotation rebalances after insert. Item gets promoted to playing.
    q = client.get(f"/api/rooms/{rid}/queue").json()
    assert len(q) == 1
    assert q[0]["status"] == "playing"


def test_fair_rotation_interleave(client):
    rid = _mk_room(client)
    # alice queues 3, bob queues 2; first item plays, remaining 4 should interleave
    a1 = _add(client, rid, "alice", "a1")
    a2 = _add(client, rid, "alice", "a2")
    a3 = _add(client, rid, "alice", "a3")
    b1 = _add(client, rid, "bob", "b1")
    b2 = _add(client, rid, "bob", "b2")

    q = client.get(f"/api/rooms/{rid}/queue").json()
    # First (a1) is playing
    playing = [x for x in q if x["status"] == "playing"]
    assert len(playing) == 1
    assert playing[0]["video_id"] == "a1"
    # Remaining queued ordered by position
    rest = sorted([x for x in q if x["status"] == "queued"], key=lambda x: x["position"])
    nicks = [x["nickname"] for x in rest]
    # Expect interleave: alice came first so order is alice,bob,alice,bob
    assert nicks == ["alice", "bob", "alice", "bob"]


def test_remove_item(client):
    rid = _mk_room(client)
    _add(client, rid, "alice", "a1")
    item = _add(client, rid, "alice", "a2")
    r = client.delete(f"/api/rooms/{rid}/queue/{item['id']}")
    assert r.status_code == 204
    q = client.get(f"/api/rooms/{rid}/queue").json()
    assert all(x["video_id"] != "a2" for x in q)


def test_cannot_remove_playing(client):
    rid = _mk_room(client)
    item = _add(client, rid, "alice", "a1")  # becomes playing
    r = client.delete(f"/api/rooms/{rid}/queue/{item['id']}")
    assert r.status_code == 404


def test_reorder(client):
    rid = _mk_room(client)
    _add(client, rid, "alice", "a1")
    i2 = _add(client, rid, "alice", "a2")
    i3 = _add(client, rid, "bob", "b1")
    # Get queued ids
    queued = [x["id"] for x in client.get(f"/api/rooms/{rid}/queue").json()
              if x["status"] == "queued"]
    new_order = list(reversed(queued))
    r = client.patch(f"/api/rooms/{rid}/queue", json={"item_ids": new_order})
    assert r.status_code == 200
    out = [x["id"] for x in r.json() if x["status"] == "queued"]
    assert out == new_order


def test_vocal_mode_update(client):
    rid = _mk_room(client)
    _add(client, rid, "alice", "a1")
    item = _add(client, rid, "alice", "a2")
    r = client.patch(
        f"/api/rooms/{rid}/queue/{item['id']}/vocal-mode",
        json={"vocal_mode": "instrumental"},
    )
    assert r.status_code == 204
    q = client.get(f"/api/rooms/{rid}/queue").json()
    target = next(x for x in q if x["id"] == item["id"])
    assert target["vocal_mode"] == "instrumental"


def test_playback_advance(client):
    rid = _mk_room(client)
    _add(client, rid, "alice", "a1")
    _add(client, rid, "bob", "b1")
    # a1 currently playing
    r = client.post(f"/api/rooms/{rid}/playback/next")
    assert r.status_code == 200
    nxt = r.json()
    assert nxt["video_id"] == "b1"
    assert nxt["status"] == "playing"


def test_insert_next(client):
    rid = _mk_room(client)
    _add(client, rid, "alice", "a1")  # playing
    _add(client, rid, "alice", "a2")  # queued
    target = _add(client, rid, "bob", "b1")  # queued, last
    r = client.post(f"/api/rooms/{rid}/queue/{target['id']}/insert-next")
    assert r.status_code == 204
    queued = sorted(
        [x for x in client.get(f"/api/rooms/{rid}/queue").json() if x["status"] == "queued"],
        key=lambda x: x["position"],
    )
    assert queued[0]["id"] == target["id"]
