/** Shared API types mirroring backend Pydantic models. */
export type Room = {
  id: string;
  name: string;
  created_at: number;
  timer_started_at: number | null;
  rate_per_minute: number;
  skip_mode?: "owner" | "vote";
  owner_user_id?: string | null;
  theme?: string;
  ends_at?: number | null;
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
export type PerformanceMode = "solo" | "duet" | "chorus";
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
  performance_mode?: PerformanceMode;
  duet_partner_user_id?: string | null;
  duet_partner_nickname?: string | null;
  dedicate_to_user_id?: string | null;
  dedicate_to_nickname?: string | null;
  position: number;
  status: QueueStatus;
  added_at: number;
  started_at: number | null;
};

export type StreamInfo = {
  video_id: string;
  video_url: string;
  audio_url: string | null;
  instrumental_url: string | null;
  expires_at: number | null;
  has_subs: boolean;
  intro_trim_sec: number;
  outro_trim_sec: number;
};

export type LyricLine = { time: number; text: string };
export type LyricWord = { start: number; end: number; text: string };
export type LyricsResponse = {
  video_id: string;
  source: "youtube" | "lrclib" | "fallback";
  title: string | null;
  artist: string | null;
  lines: LyricLine[];
  words: LyricWord[];
  lyric_offset_sec: number;
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
    // FastAPI errors come back as {detail: ...} where detail is either a plain
    // string or our structured {code, message}. Surface the human message so
    // toasts read like "已被 YouTube 限流，請稍後再試" instead of "429 /api/...".
    let msg = "";
    try {
      const body = JSON.parse(text);
      const d = body?.detail;
      if (typeof d === "string") msg = d;
      else if (d && typeof d.message === "string") msg = d.message;
      else if (typeof body?.message === "string") msg = body.message;
    } catch {
      msg = text;
    }
    throw new Error(msg || `請求失敗 (${r.status})`);
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
  setEndsAt: (id: string, ends_at: number | null) =>
    req<void>(`/api/rooms/${id}/ends-at`, { method: "POST", body: JSON.stringify({ ends_at }) }),
  extendRoom: (id: string, minutes: number) =>
    req<void>(`/api/rooms/${id}/extend`, { method: "POST", body: JSON.stringify({ minutes }) }),

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
      performance_mode?: PerformanceMode;
      duet_partner_user_id?: string | null;
      duet_partner_nickname?: string | null;
      dedicate_to_user_id?: string | null;
      dedicate_to_nickname?: string | null;
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
  setSkipMode: (room: string, mode: "owner" | "vote") =>
    req<void>(`/api/rooms/${room}/skip-mode/${mode}`, { method: "POST" }),
  setTheme: (room: string, theme: string) =>
    req<void>(`/api/rooms/${room}/theme/${encodeURIComponent(theme)}`, { method: "POST" }),
  playbackNext: (room: string) =>
    req<QueueItem | null>(`/api/rooms/${room}/playback/next`, { method: "POST" }),

  search: (q: string, n = 10) => req<SearchResult[]>(`/api/search?q=${encodeURIComponent(q)}&n=${n}`),
  getStream: (video_id: string) => req<StreamInfo>(`/api/songs/${video_id}/stream`),
  autoTrim: (video_id: string, duration_sec: number) =>
    req<void>(`/api/songs/${video_id}/trim-auto`, { method: "POST", body: JSON.stringify({ duration_sec }) }),
  getLyrics: (video_id: string, title?: string, artist?: string, force?: boolean) => {
    const qs = new URLSearchParams();
    if (title) qs.set("title", title);
    if (artist) qs.set("artist", artist);
    if (force) qs.set("force", "1");
    const tail = qs.toString() ? `?${qs}` : "";
    return req<LyricsResponse>(`/api/songs/${video_id}/lyrics${tail}`);
  },
  setLyricOffset: (video_id: string, offset_sec: number) =>
    req<void>(`/api/songs/${video_id}/lyric-offset`, {
      method: "POST",
      body: JSON.stringify({ video_id, offset_sec }),
    }),
  getLocalCharts: (period: "week" | "month" = "week") =>
    req<Array<{ video_id: string; title: string; play_count: number }>>(`/api/charts/local?period=${period}`),
  getPopularArtists: (limit = 40) =>
    req<Array<{ artist: string; play_count: number }>>(`/api/artists/popular?limit=${limit}`),
  getPronunciation: (video_id: string, lang: "zh" | "ja" = "zh") =>
    req<{ video_id: string; lang: string; items: Array<{ idx: number; text: string; anno: string }> }>(`/api/songs/${video_id}/pronunciation?lang=${lang}`),
  syncSongMetadata: (video_id: string) =>
    req<{ video_id: string; musicbrainz_artist: string | null; spotify_artist_id: string | null; spotify_track_id: string | null }>(`/api/songs/${video_id}/metadata/sync`, { method: "POST" }),
  reportLyricsCorrection: (video_id: string, payload: { line_time?: number; original_text?: string; corrected_text: string; user_id?: string }) =>
    req<{ ok: boolean }>(`/api/songs/${video_id}/lyrics-correction`, { method: "POST", body: JSON.stringify(payload) }),
  requestInstrumental: (video_id: string) =>
    req<{ status: string; job_id?: string; path?: string }>(`/api/songs/${video_id}/instrumental`, {
      method: "POST",
    }),

  getUserHistory: (user_id: string) =>
    req<Array<{ video_id: string; title: string; nickname: string; created_at: number }>>(
      `/api/users/${encodeURIComponent(user_id)}/history`,
    ),
  getFavorites: (user_id: string) =>
    req<Array<{ video_id: string; title: string; created_at: number }>>(
      `/api/users/${encodeURIComponent(user_id)}/favorites`,
    ),
  addFavorite: (user_id: string, video_id: string, title: string) =>
    req<{ ok: boolean }>(`/api/users/${encodeURIComponent(user_id)}/favorites`, {
      method: "POST",
      body: JSON.stringify({ video_id, title }),
    }),
  removeFavorite: (user_id: string, video_id: string) =>
    req<void>(
      `/api/users/${encodeURIComponent(user_id)}/favorites/${encodeURIComponent(video_id)}`,
      { method: "DELETE" },
    ),
  getRecommend: (video_id: string) =>
    req<Array<{ video_id: string; title: string; channel: string | null; thumbnail_url: string | null; duration_sec: number | null }>>(
      `/api/songs/${video_id}/recommend`,
    ),
  getWeeklyHot: (limit = 50) =>
    req<Array<{ source: string; chart_key: string; video_id: string; title: string; artist: string | null; rank_no: number }>>(
      `/api/charts/weekly-hot?limit=${limit}`,
    ),
  resolveChart: (title: string, artist?: string) => {
    const qs = new URLSearchParams({ title });
    if (artist) qs.set("artist", artist);
    return req<SearchResult | null>(`/api/charts/resolve?${qs}`);
  },
};

export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || isNaN(sec)) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
