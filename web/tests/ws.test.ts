import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RoomSocket } from "@/lib/ws";

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWS.CLOSED;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeWS.OPEN;
    this.onopen?.();
  }
  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

describe("RoomSocket", () => {
  beforeEach(() => {
    FakeWS.instances = [];
    // @ts-expect-error override
    globalThis.WebSocket = FakeWS;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects and dispatches messages to handlers", () => {
    const sock = new RoomSocket("room-1", "ws://localhost:8000");
    const handler = vi.fn();
    sock.on(handler);
    sock.connect();
    const fake = FakeWS.instances[0]!;
    expect(fake.url).toBe("ws://localhost:8000/ws/rooms/room-1");
    fake.open();
    fake.emit({ event: "queue.added", data: { id: 1 } });
    expect(handler).toHaveBeenCalledWith({ event: "queue.added", data: { id: 1 } });
    sock.close();
  });

  it("ignores malformed payloads silently", () => {
    const sock = new RoomSocket("r", "ws://x");
    const handler = vi.fn();
    sock.on(handler);
    sock.connect();
    const fake = FakeWS.instances[0]!;
    fake.open();
    fake.onmessage?.({ data: "{not-json" });
    expect(handler).not.toHaveBeenCalled();
    sock.close();
  });

  it("auto-reconnects after close", () => {
    const sock = new RoomSocket("r", "ws://x");
    sock.connect();
    const first = FakeWS.instances[0]!;
    first.open();
    first.close();
    expect(FakeWS.instances.length).toBe(1);
    vi.advanceTimersByTime(1500);
    expect(FakeWS.instances.length).toBe(2);
    sock.close();
  });

  it("send() is no-op when not open", () => {
    const sock = new RoomSocket("r", "ws://x");
    sock.connect();
    sock.send("ping", {});
    const fake = FakeWS.instances[0]!;
    expect(fake.sent.length).toBe(0);
    fake.open();
    sock.send("ping", { x: 1 });
    expect(fake.sent[0]).toContain("ping");
    sock.close();
  });

  it("close() prevents further reconnects", () => {
    const sock = new RoomSocket("r", "ws://x");
    sock.connect();
    const first = FakeWS.instances[0]!;
    first.open();
    sock.close();
    vi.advanceTimersByTime(20000);
    expect(FakeWS.instances.length).toBe(1);
  });

  it("removes handler via returned unsubscribe", () => {
    const sock = new RoomSocket("r", "ws://x");
    const h = vi.fn();
    const off = sock.on(h);
    sock.connect();
    const fake = FakeWS.instances[0]!;
    fake.open();
    off();
    fake.emit({ event: "x", data: 1 });
    expect(h).not.toHaveBeenCalled();
    sock.close();
  });
});
