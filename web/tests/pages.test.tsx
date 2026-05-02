/**
 * Page-level smoke + behavior tests for the redesigned routes.
 * These verify the rewritten pages mount, render their key UI, and respond
 * to user interactions — covering the gap between utility-only tests and
 * full E2E.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ---------- shared mocks ----------------------------------------------------

vi.mock("next/navigation", () => ({
  useParams: () => ({ roomId: "room-test" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

// In-memory mock RoomSocket — captures handlers so tests can synthesize
// server messages and connection-state transitions.
type MockHandler = (msg: { event: string; data: any }) => void;
type StateHandler = (s: 'connecting' | 'open' | 'closed' | 'reconnecting', latency: number | null) => void;

class MockSocket {
  private handlers = new Set<MockHandler>();
  private stateHandlers = new Set<StateHandler>();
  public sentMessages: Array<{ event: string; data: any }> = [];
  public closed = false;

  on(h: MockHandler) {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
  onState(h: StateHandler) {
    this.stateHandlers.add(h);
    h('connecting', null);
    return () => this.stateHandlers.delete(h);
  }
  send(event: string, data: any) {
    this.sentMessages.push({ event, data });
  }
  connect() {
    queueMicrotask(() => this.stateHandlers.forEach((h) => h('open', null)));
  }
  close() {
    this.closed = true;
  }
  emit(event: string, data: any) {
    this.handlers.forEach((h) => h({ event, data }));
  }
  emitState(s: 'connecting' | 'open' | 'closed' | 'reconnecting') {
    this.stateHandlers.forEach((h) => h(s, null));
  }
}

let lastSocket: MockSocket | null = null;
vi.mock("@/lib/ws", () => ({
  RoomSocket: class {
    constructor() {
      lastSocket = new MockSocket();
      return lastSocket as unknown as object;
    }
  },
}));

vi.mock("@/lib/qr", () => ({
  buildPhoneUrl: (origin: string, roomId: string) => `${origin}/m/${roomId}`,
  makeQrDataUrl: vi.fn().mockResolvedValue("data:image/png;base64,fake"),
}));

const apiState = {
  rooms: [{ id: "r1", name: "包廂A", created_at: 0, timer_started_at: null, rate_per_minute: 8 }],
  queue: [] as Array<any>,
  searchResults: [
    { video_id: "vid1", title: "Test Song", channel: "Test Channel", duration_sec: 200, thumbnail_url: "", view_count: 100 },
  ],
};

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<any>("@/lib/api");
  return {
    ...actual,
    api: {
      listRooms: vi.fn(async () => apiState.rooms),
      createRoom: vi.fn(async (name: string, rate: number) => {
        const r = { id: `r${apiState.rooms.length + 1}`, name, created_at: 0, timer_started_at: null, rate_per_minute: rate };
        apiState.rooms.push(r);
        return r;
      }),
      getRoom: vi.fn(async (id: string) => apiState.rooms.find((r) => r.id === id) || null),
      getQueue: vi.fn(async () => apiState.queue),
      getTimer: vi.fn(async () => ({
        room_id: "room-test", elapsed_sec: 0, cost: 0, started_at: null, rate_per_minute: 8,
      })),
      addToQueue: vi.fn(async () => ({})),
      removeQueueItem: vi.fn(async () => undefined),
      startTimer: vi.fn(),
      resetTimer: vi.fn(),
      playbackNext: vi.fn(),
      search: vi.fn(async () => apiState.searchResults),
      getStream: vi.fn(async () => null),
      getLyrics: vi.fn(async () => ({ video_id: "x", source: "fallback", title: null, artist: null, lines: [] })),
    },
  };
});

vi.mock("@/lib/identity", () => ({
  ensureIdentity: (n: string) => ({ user_id: "u-1", nickname: n }),
  getIdentity: () => ({ user_id: "u-1", nickname: "Alice" }),
  clearIdentity: vi.fn(),
}));

beforeEach(() => {
  lastSocket = null;
  apiState.queue = [];
  apiState.rooms = [{ id: "r1", name: "包廂A", created_at: 0, timer_started_at: null, rate_per_minute: 8 }];
  vi.clearAllMocks();
});

afterEach(() => {});

// ---------- Landing page ----------------------------------------------------

describe("Landing page (app/page.tsx)", () => {
  it("renders hero, lists rooms; Button asChild produces real <a> not nested-button", async () => {
    const Mod = await import("../app/page");
    render(<Mod.default />);

    expect(screen.getByText("🎤 KTV Box")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("包廂A")).toBeInTheDocument();
    });

    const tvLink = screen.getByRole("link", { name: /TV 大螢幕/i });
    expect(tvLink.tagName).toBe("A");
    expect(tvLink.getAttribute("href")).toBe("/tv/r1");
  });

  it("creates a room: types name, clicks 建立包廂, calls api.createRoom", async () => {
    const Mod = await import("../app/page");
    const { api } = await import("../lib/api");
    render(<Mod.default />);

    await waitFor(() => expect(screen.getByText("包廂A")).toBeInTheDocument());

    const nameInput = screen.getByPlaceholderText(/週末狂歡夜/);
    fireEvent.change(nameInput, { target: { value: "週六夜唱" } });

    const createBtn = screen.getByRole("button", { name: /建立包廂/ });
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(api.createRoom).toHaveBeenCalledWith("週六夜唱", 8);
    });
  });
});

// ---------- Phone page ------------------------------------------------------

describe("Phone page (app/m/[roomId]/page.tsx)", () => {
  it("mounts and reflects ws.onState transitions for reconnect indicator", async () => {
    const Mod = await import("../app/m/[roomId]/page");
    render(<Mod.default />);

    await waitFor(() => {
      expect(screen.getByText(/Alice/)).toBeInTheDocument();
    });

    await waitFor(() => expect(lastSocket).not.toBeNull());

    act(() => {
      lastSocket!.emitState("reconnecting");
    });
    await waitFor(() => {
      expect(screen.getByText(/重連中/)).toBeInTheDocument();
    });

    act(() => {
      lastSocket!.emitState("open");
    });
    await waitFor(() => {
      expect(screen.queryByText(/重連中/)).toBeNull();
    });
  });

  it("atmosphere buttons send the correct WS event", async () => {
    const Mod = await import("../app/m/[roomId]/page");
    render(<Mod.default />);
    await waitFor(() => expect(lastSocket).not.toBeNull());

    const clapBtn = screen.getByRole("button", { name: /拍手/ });
    fireEvent.click(clapBtn);

    expect(lastSocket!.sentMessages.find((m) => m.event === "atmosphere.clap")).toBeTruthy();
  });
});
