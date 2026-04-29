/** Shared API types mirroring backend Pydantic models. */
export type Room = {
  id: string;
  name: string;
  created_at: number;
  timer_started_at: number | null;
  rate_per_minute: number;
};

export type RoomTimer = {
  room_id: string;
  elapsed_sec: number;
  cost: number;
  started_at: number | null;
  rate_per_minute: number;
};

export type SearchResult = {
  video_id: string;
  title: string;
  channel: string | null;
  duration_sec: number | null;
  thumbnail_url: string | null;
  view_count: number | null;
};

export type VocalMode = "original" | "instrumental";
export type QueueStatus = "queued" | "playing" | "done" | "skipped";

export type QueueItem = {
  id: number;
  room_id: string;
  user_id: string | null;
  nickname: string;
  video_id: string;
  title: string;
  duration_sec: number | null;
  thumbnail_url: string | null;
  vocal_mode: VocalMode;
  position: number;
  status: QueueStatus;
  added_at: number;
};

export type StreamInfo = {
  video_id: string;
  video_url: string;
  audio_url: string | null;
  instrumental_url: string | null;
  expires_at: number | null;
  has_subs: boolean;
};

export type LyricLine = { time: number; text: string };
export type LyricsResponse = {
  video_id: string;
  source: "youtube" | "lrclib" | "fallback";
  title: string | null;
  artist: string | null;
  lines: LyricLine[];
};

const BASE = ""; // Same-origin via Next.js rewrites.

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    cache: "no-store",
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`${r.status} ${path}: ${text}`);
  }
  if (r.status === 204) return undefined as T;
  return r.json() as Promise<T>;
}

export const api = {
  health: () => req<{ status: string; demucs_available: boolean; cuda_available: boolean }>("/healthz"),

  createRoom: (name: string, rate_per_minute = 8) =>
    req<Room>("/api/rooms", { method: "POST", body: JSON.stringify({ name, rate_per_minute }) }),
  listRooms: () => req<Room[]>("/api/rooms"),
  getRoom: (id: string) => req<Room>(`/api/rooms/${id}`),
  deleteRoom: (id: string) => req<void>(`/api/rooms/${id}`, { method: "DELETE" }),

  getTimer: (id: string) => req<RoomTimer>(`/api/rooms/${id}/timer`),
  startTimer: (id: string) => req<RoomTimer>(`/api/rooms/${id}/timer`, { method: "POST" }),
  resetTimer: (id: string) => req<RoomTimer>(`/api/rooms/${id}/timer`, { method: "DELETE" }),

  getQueue: (id: string) => req<QueueItem[]>(`/api/rooms/${id}/queue`),
  addToQueue: (
    id: string,
    payload: {
      video_id: string;
      title: string;
      duration_sec?: number | null;
      thumbnail_url?: string | null;
      channel?: string | null;
      nickname: string;
      user_id?: string;
      vocal_mode?: VocalMode;
    },
  ) => req<QueueItem>(`/api/rooms/${id}/queue`, { method: "POST", body: JSON.stringify(payload) }),
  removeQueueItem: (room: string, item: number) =>
    req<void>(`/api/rooms/${room}/queue/${item}`, { method: "DELETE" }),
  reorderQueue: (room: string, item_ids: number[]) =>
    req<QueueItem[]>(`/api/rooms/${room}/queue`, {
      method: "PATCH",
      body: JSON.stringify({ item_ids }),
    }),
  insertNext: (room: string, item: number) =>
    req<void>(`/api/rooms/${room}/queue/${item}/insert-next`, { method: "POST" }),
  setVocalMode: (room: string, item: number, vocal_mode: VocalMode) =>
    req<void>(`/api/rooms/${room}/queue/${item}/vocal-mode`, {
      method: "PATCH",
      body: JSON.stringify({ vocal_mode }),
    }),
  playbackNext: (room: string) =>
    req<QueueItem | null>(`/api/rooms/${room}/playback/next`, { method: "POST" }),

  search: (q: string, n = 10) => req<SearchResult[]>(`/api/search?q=${encodeURIComponent(q)}&n=${n}`),
  getStream: (video_id: string) => req<StreamInfo>(`/api/songs/${video_id}/stream`),
  getLyrics: (video_id: string, title?: string, artist?: string) => {
    const qs = new URLSearchParams();
    if (title) qs.set("title", title);
    if (artist) qs.set("artist", artist);
    const tail = qs.toString() ? `?${qs}` : "";
    return req<LyricsResponse>(`/api/songs/${video_id}/lyrics${tail}`);
  },
  requestInstrumental: (video_id: string) =>
    req<{ status: string; job_id?: string; path?: string }>(`/api/songs/${video_id}/instrumental`, {
      method: "POST",
    }),
};

export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || isNaN(sec)) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
