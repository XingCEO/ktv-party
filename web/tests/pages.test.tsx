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

vi.mock("canvas-confetti", () => ({ default: vi.fn() }));

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
      playbackNext: vi.fn(async () => null),
      search: vi.fn(async () => apiState.searchResults),
      getStream: vi.fn(async (video_id: string) => ({
        video_id,
        video_url: "https://cdn.example/video.mp4",
        audio_url: null,
        instrumental_url: null,
        expires_at: null,
        has_subs: false,
        intro_trim_sec: 0,
        outro_trim_sec: 0,
      })),
      getLyrics: vi.fn(async () => ({ video_id: "x", source: "fallback", title: null, artist: null, lines: [] })),
      getPronunciation: vi.fn(async () => ({ video_id: "x", lang: "zh", items: [] })),
      getLocalCharts: vi.fn(async () => []),
      getPopularArtists: vi.fn(async () => []),
      getFavorites: vi.fn(async () => []),
      addFavorite: vi.fn(async () => ({ ok: true })),
      removeFavorite: vi.fn(async () => undefined),
      getUserHistory: vi.fn(async () => []),
      getRecommend: vi.fn(async () => []),
      getWeeklyHot: vi.fn(async () => []),
      resolveChart: vi.fn(async () => null),
      setSkipMode: vi.fn(async () => undefined),
      setTheme: vi.fn(async () => undefined),
      extendRoom: vi.fn(async () => undefined),
      setLyricOffset: vi.fn(async () => undefined),
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
    expect(lastSocket!.sentMessages).toContainEqual({
      event: "identity",
      data: { user_id: "u-1", nickname: "Alice" },
    });
    await waitFor(() => {
      expect(screen.queryByText(/重連中/)).toBeNull();
    });
  });

  it("探索 panel lists local-chart hits and 點播 adds them to the queue", async () => {
    const Mod = await import("../app/m/[roomId]/page");
    const { api } = await import("../lib/api");
    vi.mocked(api.getLocalCharts).mockResolvedValue([
      { video_id: "hot1", title: "Hot Song", play_count: 9 },
    ] as any);

    render(<Mod.default />);
    await waitFor(() => expect(lastSocket).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /探索/ }));
    expect(await screen.findByText("Hot Song")).toBeInTheDocument();

    const addBtns = screen.getAllByRole("button", { name: "點播" });
    fireEvent.click(addBtns[0]);
    await waitFor(() => expect(api.addToQueue).toHaveBeenCalled());
  });

  it("排行榜 tab resolves placeholder chart id to a real hit before queueing", async () => {
    const Mod = await import("../app/m/[roomId]/page");
    const { api } = await import("../lib/api");
    vi.mocked(api.getWeeklyHot).mockResolvedValue([
      { source: "applemusic", chart_key: "tw", video_id: "apple:1:想你", title: "想你", artist: "歌手A", rank_no: 1 },
    ] as any);
    vi.mocked(api.resolveChart).mockResolvedValue({
      video_id: "real9", title: "想你", channel: "歌手A", duration_sec: 200, thumbnail_url: "", view_count: 0,
    } as any);

    render(<Mod.default />);
    await waitFor(() => expect(lastSocket).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /探索/ }));
    fireEvent.click(screen.getByRole("button", { name: /排行榜/ }));
    expect(await screen.findByText("想你")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "點播" })[0]);
    await waitFor(() => expect(api.resolveChart).toHaveBeenCalledWith("想你", "歌手A"));
    await waitFor(() =>
      expect(api.addToQueue).toHaveBeenCalledWith(
        "room-test",
        expect.objectContaining({ video_id: "real9" }),
      ),
    );
  });

  it("對唱 mode sends the chosen partner on add", async () => {
    const Mod = await import("../app/m/[roomId]/page");
    const { api } = await import("../lib/api");

    render(<Mod.default />);
    await waitFor(() => expect(lastSocket).not.toBeNull());

    // Populate participants via snapshot so the partner picker has options.
    act(() => {
      lastSocket!.emit("room.snapshot", {
        queue: [],
        participants: [
          { user_id: "u-1", nickname: "Alice" },
          { user_id: "u-2", nickname: "Bob" },
        ],
      });
    });

    // Run a search to get an addable result.
    fireEvent.change(screen.getByPlaceholderText(/搜尋歌曲/), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "搜尋" }));
    await waitFor(() => expect(screen.getByText("Test Song")).toBeInTheDocument());

    // Switch to 對唱 and pick Bob.
    fireEvent.click(screen.getByRole("button", { name: "對唱" }));
    fireEvent.change(screen.getByLabelText("對唱夥伴"), { target: { value: "u-2" } });

    fireEvent.click(screen.getAllByRole("button", { name: "點播" })[0]);
    await waitFor(() =>
      expect(api.addToQueue).toHaveBeenCalledWith(
        "room-test",
        expect.objectContaining({
          performance_mode: "duet",
          duet_partner_user_id: "u-2",
          duet_partner_nickname: "Bob",
        }),
      ),
    );
  });

  it("shows an empty-state when search returns no results", async () => {
    const Mod = await import("../app/m/[roomId]/page");
    const { api } = await import("../lib/api");
    vi.mocked(api.search).mockResolvedValueOnce([]);

    render(<Mod.default />);
    await waitFor(() => expect(lastSocket).not.toBeNull());

    fireEvent.change(screen.getByPlaceholderText(/搜尋歌曲/), { target: { value: "zzz" } });
    fireEvent.click(screen.getByRole("button", { name: "搜尋" }));

    expect(await screen.findByText("找不到相關歌曲")).toBeInTheDocument();
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

// ---------- TV page ---------------------------------------------------------

describe("TV page (app/tv/[roomId]/page.tsx)", () => {
  it("shows an error card and can skip when the stream fails to resolve", async () => {
    apiState.queue = [{
      id: 7, room_id: "room-test", user_id: "u-1", nickname: "Alice",
      video_id: "bad1", title: "Broken Video", duration_sec: 200, thumbnail_url: "",
      vocal_mode: "original", position: 1, status: "playing", added_at: 0, started_at: 1,
    }];
    const Mod = await import("../app/tv/[roomId]/page");
    const { api } = await import("../lib/api");
    vi.mocked(api.getStream).mockRejectedValueOnce(new Error("403 private"));

    render(<Mod.default />);
    await waitFor(() => expect(lastSocket).not.toBeNull());

    expect(await screen.findByText("無法載入此影片")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "立即跳過" }));
    await waitFor(() => expect(api.playbackNext).toHaveBeenCalledWith("room-test"));
  });

  it("applies presence and vocal-mode websocket updates", async () => {
    apiState.queue = [{
      id: 1,
      room_id: "room-test",
      user_id: "u-1",
      nickname: "Alice",
      video_id: "vid1",
      title: "Test Song",
      duration_sec: 200,
      thumbnail_url: "",
      vocal_mode: "original",
      position: 1,
      status: "playing",
      added_at: 0,
      started_at: 1,
    }];

    const Mod = await import("../app/tv/[roomId]/page");
    const { api } = await import("../lib/api");
    render(<Mod.default />);

    await waitFor(() => expect(lastSocket).not.toBeNull());
    await waitFor(() => expect(api.getStream).toHaveBeenCalledWith("vid1"));
    vi.mocked(api.getStream).mockClear();

    act(() => {
      lastSocket!.emit("presence.joined", { nickname: "Bob" });
    });
    expect(await screen.findByText("Bob")).toBeInTheDocument();

    act(() => {
      lastSocket!.emit("queue.vocal_mode.updated", {
        item_id: 1,
        vocal_mode: "instrumental",
        queue: [{ ...apiState.queue[0], vocal_mode: "instrumental" }],
      });
    });

    await waitFor(() => expect(api.getStream).toHaveBeenCalledWith("vid1"));
  });
});
