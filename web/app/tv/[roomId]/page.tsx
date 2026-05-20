"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  api,
  fmtDuration,
  type LyricLine,
  type LyricsResponse,
  type QueueItem,
  type Room,
  type RoomTimer,
  type StreamInfo,
} from "@/lib/api";
import { RoomSocket } from "@/lib/ws";
import { buildPhoneUrl, makeQrDataUrl } from "@/lib/qr";
import Atmosphere from "@/components/atmosphere/Atmosphere";
import FloatingEmoji from "@/components/atmosphere/FloatingEmoji";
import ComboEffect, { type ComboTrigger } from "@/components/effects/ComboEffect";
import PresenceToast, { type PresenceEvent } from "@/components/effects/PresenceToast";
import { ScoreScreen } from "@/components/effects/ScoreScreen";
import { KaraokeLine } from "@/components/lyrics/KaraokeLine";

type AtmosphereKind = "confetti" | "fireworks" | "clap" | "birthday";
type Participant = { nickname?: string; user_id?: string };
type ScoreState = { songTitle: string; singerName: string; seed: string } | null;

function isAtmosphereKind(kind: string): kind is AtmosphereKind {
  return kind === "confetti" || kind === "fireworks" || kind === "clap" || kind === "birthday";
}

export default function TvPage() {
  const params = useParams<{ roomId: string }>();
  const roomId = params.roomId;
  const [room, setRoom] = useState<Room | null>(null);
  const [timer, setTimer] = useState<RoomTimer | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [stream, setStream] = useState<StreamInfo | null>(null);
  const [lyrics, setLyrics] = useState<LyricsResponse | null>(null);
  const [qrUrl, setQrUrl] = useState<string>("");
  const [phoneUrl, setPhoneUrl] = useState<string>("");
  const [now, setNow] = useState(0);
  const [atmosphere, setAtmosphere] = useState<{ kind: AtmosphereKind; ts: number } | null>(null);
  const [emojiTrigger, setEmojiTrigger] = useState<{ kind: string; ts: number } | null>(null);
  const [comboTrigger, setComboTrigger] = useState<ComboTrigger>(null);
  const [presenceTrigger, setPresenceTrigger] = useState<PresenceEvent>(null);
  const [barrages, setBarrages] = useState<Array<{ id: number; text: string }>>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [score, setScore] = useState<ScoreState>(null);
  const [idleCharts, setIdleCharts] = useState<Array<{ video_id: string; title: string; play_count: number }>>([]);
  const [streamError, setStreamError] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [lyricsExpanded, setLyricsExpanded] = useState(false);
  const [theme, setTheme] = useState("cashbox-green");
  // Sync nudge: positive value makes lyrics appear earlier (compensates intro padding
  // on YouTube uploads vs. lrclib's album-master timing). Re-zeroed per song.
  const [lyricOffsetSec, setLyricOffsetSec] = useState(0);
  const [lyricClockSec, setLyricClockSec] = useState(0);
  const [annoOn, setAnnoOn] = useState(false);
  const [annoLang, setAnnoLang] = useState<"zh" | "ja">("zh");
  const [annoMap, setAnnoMap] = useState<Record<string, string>>({});
  const [activeLyricIdx, setActiveLyricIdx] = useState(-1);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const wsRef = useRef<RoomSocket | null>(null);
  const lastVideoIdRef = useRef<string | null>(null);
  const activeIdxRef = useRef(-1);
  const fetchTokenRef = useRef<string | null>(null);
  const playingRef = useRef<QueueItem | null>(null);
  const lyricClockRef = useRef(-1);
  // performance.now() at the moment both elements were play()'d. The sync tick
  // suppresses hard-seeks during the first few seconds — buffer is still
  // filling and any seek there lands in still-loading territory.
  const playbackStartedAtRef = useRef<number>(0);

  const playing = useMemo(() => queue.find((q) => q.status === "playing") || null, [queue]);
  const playingVideoId = playing?.video_id;
  const playingTitle = playing?.title;
  const externalAudioUrl = useMemo(() => {
    if (!stream) return null;
    if (playing?.vocal_mode === "instrumental" && stream.instrumental_url) return stream.instrumental_url;
    return stream.audio_url || null;
  }, [stream, playing?.vocal_mode]);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  const applyLyricNudge = useCallback((delta: number, videoId?: string) => {
    const targetVideoId = videoId ?? playingRef.current?.video_id;
    setLyricOffsetSec((v) => {
      const next = Math.round((v + delta) * 10) / 10;
      if (targetVideoId && typeof window !== "undefined") {
        try {
          window.localStorage.setItem(`ktv-lyric-offset-${targetVideoId}`, String(next));
        } catch {
          /* quota: ignore */
        }
      }
      return next;
    });
  }, []);

  // Initial load + QR
  useEffect(() => {
    api.getRoom(roomId).then(setRoom).catch(console.error);
    api.getQueue(roomId).then(setQueue).catch(console.error);
    api.getTimer(roomId).then(setTimer).catch(console.error);
    if (typeof window !== "undefined") {
      const url = buildPhoneUrl(window.location.origin, roomId);
      setPhoneUrl(url);
      makeQrDataUrl(url, 256).then(setQrUrl).catch(console.error);
    }
  }, [roomId]);

  // Idle attract screen: when nothing is playing, surface the room's most-played
  // songs so a quiet room shows inspiration instead of a bare QR. Refreshes when
  // the room goes idle again (e.g. after the last queued song finishes).
  useEffect(() => {
    if (playing) return;
    api.getLocalCharts("week").then((rows) => setIdleCharts(rows.slice(0, 6))).catch(() => {});
  }, [playing]);

  // WebSocket
  useEffect(() => {
    const ws = new RoomSocket(roomId);
    wsRef.current = ws;
    const off = ws.on((m) => {
      if (m.event === "room.snapshot") {
        setQueue(m.data.queue || []);
        setTimer(m.data.timer);
        setParticipants(m.data.participants || []);
        return;
      }

      if (
        m.event === "queue.added" ||
        m.event === "queue.removed" ||
        m.event === "queue.reordered" ||
        m.event === "queue.vocal_mode.updated"
      ) {
        setQueue(m.data.queue || []);
        const currentPlaying = playingRef.current;
        if (m.event === "queue.vocal_mode.updated" && currentPlaying && m.data.item_id === currentPlaying.id) {
          api.getStream(currentPlaying.video_id).then(setStream).catch(console.error);
        }
        return;
      }

      if (m.event === "playback.advanced") {
        const previous = playingRef.current;
        const current = m.data.current as QueueItem | null | undefined;
        if (previous && previous.id !== current?.id) {
          setScore({
            songTitle: previous.title,
            singerName: previous.nickname,
            seed: `${previous.id}:${previous.video_id}:${previous.nickname}`,
          });
        }
        setQueue(m.data.queue || []);
        return;
      }

      if (m.event === "atmosphere.combo") {
        const ts = Date.now();
        setComboTrigger({
          kind: m.data.kind,
          count: m.data.count,
          multiplier: m.data.multiplier,
          ts,
        });
        setEmojiTrigger({ kind: `atmosphere.${m.data.kind}`, ts });
        return;
      }

      if (m.event.startsWith("atmosphere.")) {
        const ts = Date.now();
        const kind = m.event.replace("atmosphere.", "");
        if (isAtmosphereKind(kind)) {
          setAtmosphere({ kind, ts });
        }
        setEmojiTrigger({ kind: m.event, ts });
        return;
      }

      const currentPlaying = playingRef.current;
      if (m.event === "vocal_removal.ready" && currentPlaying && m.data.video_id === currentPlaying.video_id) {
        // reload stream to pick up instrumental
        api.getStream(currentPlaying.video_id).then(setStream).catch(console.error);
        return;
      }

      if (m.event === "room.timer.started" || m.event === "room.timer.reset") {
        setTimer(m.data as RoomTimer);
        return;
      }

      if (m.event === "presence.updated") {
        setParticipants(m.data.participants || []);
        return;
      }

      if (m.event === "presence.joined" || m.event === "presence.left") {
        setPresenceTrigger({
          kind: m.event === "presence.joined" ? "joined" : "left",
          nickname: m.data.nickname,
          ts: Date.now(),
        });
        return;
      }

      if (m.event === "insert_top") {
        setQueue(m.data.queue || []);
        setPresenceTrigger({
          kind: "joined",
          nickname: m.data?.message || "有人插播了一首",
          ts: Date.now(),
        });
        return;
      }

      if (m.event === "chat.message") {
        if (m.data?.kind === "emoji") {
          setEmojiTrigger({ kind: "atmosphere.clap", ts: Date.now() });
        } else if (m.data?.message) {
          const text = `${m.data.nickname || "匿名"}: ${m.data.message}`;
          setBarrages((prev) => [...prev.slice(-5), { id: Date.now(), text }]);
        }
        return;
      }

      if (m.event === "room.theme" && m.data?.theme) {
        setTheme(String(m.data.theme));
        return;
      }

      if (m.event === "room.countdown") {
        const sec = Number(m.data?.remaining_sec || 0);
        const min = Math.max(1, Math.round(sec / 60));
        setPresenceTrigger({ kind: "joined", nickname: `剩餘 ${min} 分鐘`, ts: Date.now() });
        return;
      }

      if (m.event === "room.extended") {
        setPresenceTrigger({ kind: "joined", nickname: `已續鐘 ${m.data?.minutes || 0} 分`, ts: Date.now() });
        return;
      }

      if (m.event === "lyric.nudge") {
        const current = playingRef.current;
        if (current && m.data.item_id === current.id && typeof m.data.delta_sec === "number") {
          applyLyricNudge(m.data.delta_sec, current.video_id);
        }
      }
    });
    ws.connect();
    return () => {
      off();
      ws.close();
    };
  }, [applyLyricNudge, roomId]);

  // When playing changes, fetch stream + lyrics. Clear immediately so the
  // previous song's lyrics don't linger, and guard against a late response
  // for the previous song stomping the current one.
  useEffect(() => {
    if (!barrages.length) return;
    const t = setTimeout(() => setBarrages((prev) => prev.slice(1)), 2600);
    return () => clearTimeout(t);
  }, [barrages]);

  useEffect(() => {
    if (!playingVideoId) {
      setStream(null);
      setLyrics(null);
      return;
    }
    setStream(null);
    setLyrics(null);
    setStreamError(false);
    const myId = playingVideoId;
    fetchTokenRef.current = myId;
    api.getStream(myId).then((s) => {
      if (fetchTokenRef.current === myId) setStream(s);
    }).catch((e) => {
      console.error(e);
      // Initial resolve failed (private / geo-blocked / expired). Surface it and
      // let the auto-skip effect advance past the broken song quickly.
      if (fetchTokenRef.current === myId) setStreamError(true);
    });
    api.getLyrics(myId, playingTitle).then((l) => {
      if (fetchTokenRef.current === myId) setLyrics(l);
    }).catch(console.error);
    api.getPronunciation(myId, annoLang).then((r) => {
      if (fetchTokenRef.current !== myId) return;
      const map: Record<string, string> = {};
      r.items.forEach((it) => {
        if (it.text && it.anno && !map[it.text]) map[it.text] = it.anno;
      });
      setAnnoMap(map);
    }).catch(() => setAnnoMap({}));
  }, [playingVideoId, playingTitle, annoLang]);

  // If the playing song's stream can't be resolved, don't sit on a broken/black
  // screen for the full song duration waiting on the server scheduler — advance
  // past it after a short notice.
  useEffect(() => {
    if (!streamError || !playing) return;
    const t = setTimeout(() => {
      api.playbackNext(roomId).catch(console.error);
    }, 5000);
    return () => clearTimeout(t);
  }, [streamError, playing, roomId]);

  // Auto-attach ended handler. (currentTime is read in the rAF tick below, not
  // via timeupdate, since timeupdate only fires ~4Hz on most browsers.)
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    const itemId = playing?.id;
    const onEnded = () => {
      // Server is the source of truth for advancement (services/scheduler.py).
      // We just send a fast-path hint via WS — the server validates it (>=30s
      // playing) and decides whether to advance. This way, a TV refresh /
      // browser crash never blocks the queue: the server scheduler advances
      // overdue songs even without a healthy TV.
      wsRef.current?.send("playback.endHint", { item_id: itemId });
    };
    const onTimeForOutro = () => {
      const outroTrim = Math.max(0, stream.outro_trim_sec || 0);
      if (!outroTrim || !Number.isFinite(v.duration) || v.duration <= 0) return;
      if (v.currentTime >= Math.max(0, v.duration - outroTrim)) {
        wsRef.current?.send("playback.endHint", { item_id: itemId, auto_trim: true });
      }
    };
    v.addEventListener("ended", onEnded);
    v.addEventListener("timeupdate", onTimeForOutro);
    return () => {
      v.removeEventListener("ended", onEnded);
      v.removeEventListener("timeupdate", onTimeForOutro);
    };
  }, [stream, playing?.id]);

  // Coordinated start: load video + (optional) external audio together and
  // gate play() on BOTH elements reaching `canplay`. Starting the video alone
  // while audio was still buffering produced the front-of-song stutter — the
  // 500ms sync tick would detect drift, hard-seek audio into an unbuffered
  // region, stall, and loop. Also resumes currentTime on mid-song URL refresh
  // so the singer isn't yanked back to t=0.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    const a = audioRef.current;
    const audioUrl = externalAudioUrl;
    const useAudio = !!(a && audioUrl);
    const sameSong = lastVideoIdRef.current === stream.video_id;
    const introTrim = Math.max(0, stream.intro_trim_sec || 0);
    const resumeAt = sameSong ? Math.max(introTrim, v.currentTime) : introTrim;
    const wasPlaying = sameSong && !v.paused;
    v.pause();
    v.preload = "auto";
    v.src = stream.video_url;
    v.load();
    if (useAudio && a) {
      a.pause();
      a.preload = "auto";
      a.src = audioUrl!;
      a.load();
    }
    let started = false;
    let cancelled = false;
    const startBoth = () => {
      if (started || cancelled) return;
      // canplay = readyState 3 (HAVE_FUTURE_DATA). Wait for both before play.
      if (v.readyState < 3) return;
      if (useAudio && a && a.readyState < 3) return;
      started = true;
      playbackStartedAtRef.current = performance.now();
      if (resumeAt > 0.5) {
        v.currentTime = resumeAt;
        if (useAudio && a) a.currentTime = resumeAt;
      }
      if (wasPlaying || !sameSong) {
        v.play().catch(() => {});
        if (useAudio && a) a.play().catch(() => {});
      }
    };
    const onVReady = () => startBoth();
    const onAReady = () => startBoth();
    v.addEventListener("canplay", onVReady);
    if (useAudio && a) a.addEventListener("canplay", onAReady);
    // Safety: if audio never reaches canplay (CDN flake, codec issue), play
    // video alone after 4s so we don't sit on a black screen forever.
    const fallback = setTimeout(() => {
      if (!started && !cancelled && v.readyState >= 2) {
        started = true;
        playbackStartedAtRef.current = performance.now();
        if (resumeAt > 0.5) v.currentTime = resumeAt;
        if (wasPlaying || !sameSong) v.play().catch(() => {});
        if (useAudio && a) a.play().catch(() => {});
      }
    }, 4000);
    lastVideoIdRef.current = stream.video_id;
    return () => {
      cancelled = true;
      clearTimeout(fallback);
      v.removeEventListener("canplay", onVReady);
      if (a) a.removeEventListener("canplay", onAReady);
    };
  }, [stream, externalAudioUrl]);

  // Stream URLs from yt-dlp expire (typ. ~6h). Re-fetch shortly before expiry so
  // long-running playback / idle TV doesn't break with a 403 mid-song.
  useEffect(() => {
    if (!playing || !stream?.expires_at) return;
    const refreshAtMs = Math.max(5_000, (stream.expires_at - 600) * 1000 - Date.now());
    const t = setTimeout(() => {
      api.getStream(playing.video_id).then(setStream).catch(console.error);
    }, refreshAtMs);
    return () => clearTimeout(t);
  }, [stream?.expires_at, playing]);

  // Recover from forbidden / network errors on the video element by re-fetching the stream.
  // Throttle: a flaky CDN can fire `error` repeatedly while the front of the song is
  // still settling, which without a cooldown loops re-fetch → reset src → reload-from-0
  // and feels like the video keeps restarting.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !playing) return;
    let lastFetchAt = 0;
    const onError = () => {
      const now = Date.now();
      if (now - lastFetchAt < 5000) return;
      lastFetchAt = now;
      api.getStream(playing.video_id).then(setStream).catch(console.error);
    };
    v.addEventListener("error", onError);
    return () => v.removeEventListener("error", onError);
  }, [playing]);

  // Mute video when an external audio track is in use (split DASH or instrumental)
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !!externalAudioUrl;
  }, [externalAudioUrl]);

  // Force fade-out for long videos (over 6 min), avoid hard cut on transition.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      const remain = 360 - v.currentTime;
      if (remain <= 8 && remain > 0) {
        v.volume = Math.max(0, Math.min(1, remain / 8));
      } else if (remain <= 0) {
        v.volume = 0;
      } else {
        v.volume = 1;
      }
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, []);

  // Sync external audio track with video time (DASH split / instrumental).
  // Three layers of stutter-avoidance:
  //   1. Settle window — for the first 3s after coordinated start, never seek
  //      and never nudge playbackRate. The buffer is still filling; any
  //      adjustment lands in unbuffered territory and causes the very stutter
  //      we're trying to suppress.
  //   2. After settle, nudge playbackRate for small drift (<0.5s).
  //   3. Hard-seek (heavily debounced) only when truly out of sync (>0.5s)
  //      AND audio has enough buffered data ahead of the target to avoid
  //      seeking into still-loading territory.
  useEffect(() => {
    const v = videoRef.current;
    const a = audioRef.current;
    if (!v || !a || !externalAudioUrl) return;
    let lastSeekAt = 0;
    const SETTLE_MS = 3000;
    const inSettle = () => {
      const s = playbackStartedAtRef.current;
      return s > 0 && performance.now() - s < SETTLE_MS;
    };
    const bufferedAhead = (el: HTMLMediaElement, target: number): number => {
      for (let i = 0; i < el.buffered.length; i++) {
        const start = el.buffered.start(i);
        const end = el.buffered.end(i);
        if (target >= start && target <= end) return end - target;
      }
      return 0;
    };
    const sync = () => {
      if (a.seeking || a.readyState < 2) return;
      const drift = a.currentTime - v.currentTime;
      const abs = Math.abs(drift);
      if (inSettle()) return;
      if (abs > 0.5) {
        const now = performance.now();
        if (now - lastSeekAt < 1500) return;
        // Only hard-seek if audio has at least 1s buffered past the target;
        // otherwise the seek will stall and we'll just re-detect drift next tick.
        if (bufferedAhead(a, v.currentTime) < 1.0) return;
        lastSeekAt = now;
        a.currentTime = v.currentTime;
        a.playbackRate = 1;
        return;
      }
      if (abs > 0.05) {
        a.playbackRate = drift < 0 ? 1.02 : 0.98;
      } else {
        a.playbackRate = 1;
      }
    };
    const onPlay = () => a.play().catch(() => {});
    const onPause = () => a.pause();
    const onSeek = () => {
      a.currentTime = v.currentTime;
      a.playbackRate = 1;
      lastSeekAt = performance.now();
    };
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeked", onSeek);
    const tick = setInterval(sync, 500);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", onSeek);
      clearInterval(tick);
      a.playbackRate = 1;
    };
  }, [externalAudioUrl]);

  // Cost timer ticker (1Hz local extrapolation)
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now() / 1000);
      if (timer?.started_at) {
        const elapsed = Date.now() / 1000 - timer.started_at;
        setTimer({ ...timer, elapsed_sec: elapsed, cost: Math.round((elapsed / 60) * timer.rate_per_minute * 100) / 100 });
      }
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timer]);

  async function startTimer() {
    setTimer(await api.startTimer(roomId));
  }
  async function resetTimer() {
    if (!confirm("確定要重置計費?")) return;
    setTimer(await api.resetTimer(roomId));
  }
  async function skipSong() {
    await api.playbackNext(roomId);
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === "q" || ((event.metaKey || event.ctrlKey) && key === "k")) {
        event.preventDefault();
        setQueueOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Drive active-lyric tracking from rAF — `<video>` timeupdate only fires ~4Hz
  // and produced visible 100-250ms lag at line transitions. Reading currentTime
  // directly per frame and only setStating when the line index changes keeps
  // re-renders cheap while making the highlight feel exact.
  useEffect(() => {
    if (!lyrics?.lines.length || !playing) {
      activeIdxRef.current = -1;
      setActiveLyricIdx(-1);
      return;
    }
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        const t = v.currentTime + lyricOffsetSec;
        const rounded = Math.round(t * 10) / 10;
        if (rounded !== lyricClockRef.current) {
          lyricClockRef.current = rounded;
          setLyricClockSec(rounded);
        }
        let idx = -1;
        const lines = lyrics.lines;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].time <= t) idx = i;
          else break;
        }
        if (idx !== activeIdxRef.current) {
          activeIdxRef.current = idx;
          setActiveLyricIdx(idx);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [lyrics, playing, lyricOffsetSec]);

  // Per-song offset is sticky — once a singer dials in the right number for a
  // particular YouTube upload (intro padding varies), replaying it later (or
  // later in the same party) reuses the same offset instead of resetting to 0.
  useEffect(() => {
    if (!playing) return;
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(`ktv-lyric-offset-${playing.video_id}`);
      setLyricOffsetSec(raw ? Number(raw) || 0 : 0);
    } catch {
      setLyricOffsetSec(0);
    }
  }, [playing]);

  function nudgeOffset(delta: number) {
    setLyricOffsetSec((v) => {
      const next = Math.round((v + delta) * 10) / 10;
      if (playing && typeof window !== "undefined") {
        try {
          window.localStorage.setItem(`ktv-lyric-offset-${playing.video_id}`, String(next));
        } catch {
          /* quota — ignore */
        }
      }
      return next;
    });
  }

  const themeClass =
    theme === "star-purple"
      ? "bg-[#170f2a]"
      : theme === "holiday-blue"
        ? "bg-[#0b1730]"
        : theme === "retro"
          ? "bg-[#2a1a0f]"
          : theme === "dark"
            ? "bg-black"
            : "bg-ktv-bg";

  return (
    <main className={`min-h-screen flex flex-col text-white transition-colors duration-300 ${themeClass}`}>
      <Atmosphere trigger={atmosphere} />
      <FloatingEmoji trigger={emojiTrigger} />
      <ComboEffect trigger={comboTrigger} />
      <PresenceToast trigger={presenceTrigger} />
      <div className="fixed top-20 left-0 right-0 pointer-events-none z-40 space-y-2 px-4">
        {barrages.map((b) => (
          <motion.div
            key={b.id}
            initial={{ x: 300, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -300, opacity: 0 }}
            className="ml-auto w-fit max-w-[70%] rounded-full bg-black/55 px-4 py-1 text-sm text-white/90"
          >
            {b.text}
          </motion.div>
        ))}
      </div>
      <ScoreScreen
        visible={!!score}
        songTitle={score?.songTitle || ""}
        singerName={score?.singerName || ""}
        seed={score?.seed || ""}
        onDismiss={() => setScore(null)}
      />

      {/* Top bar */}
      <header className="flex items-center justify-between px-6 py-3 bg-ktv-panel/70 border-b border-white/5">
        <div className="flex items-center gap-4">
          <div className="text-2xl font-extrabold text-ktv-gold">🎤 KTV Box</div>
          <div className="text-white/70">{room?.name || roomId}</div>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <div>
            <span className="text-white/50">用時 </span>
            <span className="font-mono text-lg">{fmtDuration(timer?.elapsed_sec || 0)}</span>
          </div>
          <div>
            <span className="text-white/50">費用 </span>
            <span className="font-mono text-lg text-ktv-gold">${timer?.cost ?? 0}</span>
          </div>
          <div>
            <span className="text-white/50">Online </span>
            <span className="font-mono text-lg text-ktv-mic">{participants.length}</span>
          </div>
          <button type="button" className="btn-ghost" onClick={() => setQueueOpen((v) => !v)}>
            Queue ({queue.length})
          </button>
          {!timer?.started_at ? (
            <button type="button" className="btn-primary" onClick={startTimer}>開始計費</button>
          ) : (
            <button type="button" className="btn-ghost" onClick={resetTimer}>重置</button>
          )}
          <button type="button" className="btn-ghost" onClick={skipSong}>下一首</button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setLyricsExpanded((v) => !v)}
            title="切換歌詞大小"
          >
            {lyricsExpanded ? "縮小歌詞" : "放大歌詞"}
          </button>
          <button type="button" className="btn-ghost" onClick={() => setAnnoOn((v) => !v)}>
            {annoOn ? "關標註" : "注/拼"}
          </button>
          <button type="button" className="btn-ghost" onClick={() => setAnnoLang((v) => (v === "zh" ? "ja" : "zh"))}>
            {annoLang.toUpperCase()}
          </button>
          {playing && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setLyrics(null);
                api
                  .getLyrics(playing.video_id, playing.title, undefined, true)
                  .then(setLyrics)
                  .catch(console.error);
              }}
              title="重新抓取歌詞 (清空快取)"
            >
              重抓歌詞
            </button>
          )}
          {playing && lyrics?.lines.length ? (
            <div className="flex items-center gap-1 text-sm" title="歌詞時間微調 (此曲記住)">
              <button type="button" className="btn-ghost px-2" onClick={() => nudgeOffset(-1.0)} title="歌詞慢 1 秒">
                ⏮
              </button>
              <button type="button" className="btn-ghost px-2" onClick={() => nudgeOffset(-0.3)} title="歌詞慢 0.3 秒">
                ⏪
              </button>
              <span className="font-mono text-xs text-ktv-gold w-14 text-center">
                {lyricOffsetSec >= 0 ? "+" : ""}{lyricOffsetSec.toFixed(1)}s
              </span>
              <button type="button" className="btn-ghost px-2" onClick={() => nudgeOffset(0.3)} title="歌詞快 0.3 秒">
                ⏩
              </button>
              <button type="button" className="btn-ghost px-2" onClick={() => nudgeOffset(1.0)} title="歌詞快 1 秒">
                ⏭
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {/* Main grid */}
      <div className="flex-1 grid grid-cols-12 gap-4 p-4 min-h-0">
        {/* Video + lyrics */}
        <section className="col-span-12 panel overflow-hidden flex flex-col min-h-0">
          {playing && stream ? (
            <>
              <div className="relative bg-black flex-1 min-h-0">
                {/* src is set imperatively in an effect so URL refreshes don't reset currentTime */}
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  preload="auto"
                  // Set muted via JSX prop so the autoplay attempt sees the right
                  // value at first paint — setting it later via an effect was
                  // racing the autoplay policy and could leave the element paused.
                  muted={!!externalAudioUrl}
                  className="w-full h-full object-contain"
                >
                  <track kind="captions" srcLang="zh" label="lyrics" src="data:text/vtt,WEBVTT" default />
                </video>
                {externalAudioUrl && (
                  <audio ref={audioRef} preload="auto">
                    <track kind="captions" srcLang="zh" label="lyrics" src="data:text/vtt,WEBVTT" default />
                  </audio>
                )}
                <div className="absolute top-4 left-4 panel px-3 py-1 text-sm">
                  <span className="text-ktv-gold font-bold">{playing.title}</span>
                  <span className="text-white/60 ml-2">@{playing.nickname}</span>
                  {playing.dedicate_to_nickname && (
                    <span className="ml-2 pill bg-ktv-accent text-white">來自點播給 {playing.dedicate_to_nickname}</span>
                  )}
                  {playing.vocal_mode === "instrumental" && (
                    <span className="ml-2 pill bg-ktv-mic text-black">伴奏</span>
                  )}
                </div>
                {/* Keep the join QR visible without leaving the main video surface. */}
                {qrUrl && (
                  <div className="absolute right-4 bottom-4 z-10 rounded-xl bg-white p-1.5 shadow-2xl transition-transform hover:scale-150 hover:origin-bottom-right">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={qrUrl} alt="QR" className="h-20 w-20 rounded-lg" />
                  </div>
                )}
                {/* Lyrics overlay. Gradient backdrop keeps text
                    readable over busy MV footage. Active line is centered and large; a
                    dimmed next-line preview sits below it. */}
                <div
                  className={`absolute inset-x-0 bottom-0 px-6 flex flex-col items-center justify-end pointer-events-none bg-gradient-to-t from-black/85 via-black/55 to-transparent transition-all duration-300 ${
                    lyricsExpanded ? "pt-16 pb-10" : "pt-10 pb-6"
                  }`}
                >
                  {lyrics?.lines.length ? (
                    <>
                      <AnimatePresence mode="wait">
                        {activeLyricIdx >= 0 && lyrics.lines[activeLyricIdx] ? (
                          <motion.div
                            key={`active-${lyrics.lines[activeLyricIdx].time}`}
                            initial={{ opacity: 0, y: 12 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -12 }}
                            transition={{ duration: 0.12 }}
                            className={`text-center font-extrabold text-ktv-gold leading-tight [text-shadow:_0_2px_8px_rgba(0,0,0,0.95),_0_0_2px_rgba(0,0,0,0.95)] ${
                              lyricsExpanded ? "text-6xl md:text-7xl" : "text-4xl md:text-5xl"
                            }`}
                          >
                            <KaraokeLine
                              text={lyrics.lines[activeLyricIdx].text}
                              startSec={lyrics.lines[activeLyricIdx].time}
                              endSec={lyrics.lines[activeLyricIdx + 1]?.time ?? lyrics.lines[activeLyricIdx].time + 4}
                              currentSec={lyricClockSec}
                            />
                          </motion.div>
                        ) : (
                          <motion.div
                            key="prelude"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 0.6 }}
                            exit={{ opacity: 0 }}
                            className="text-white/60 text-xl [text-shadow:_0_2px_4px_rgba(0,0,0,0.95)]"
                          >
                            ♪ ♪ ♪
                          </motion.div>
                        )}
                      </AnimatePresence>
                      {annoOn && activeLyricIdx >= 0 && lyrics.lines[activeLyricIdx] && annoMap[lyrics.lines[activeLyricIdx].text] && (
                        <div
                          className={`mt-2 text-center text-ktv-mic font-semibold [text-shadow:_0_2px_6px_rgba(0,0,0,0.95)] ${
                            lyricsExpanded ? "text-2xl" : "text-lg"
                          }`}
                        >
                          {annoMap[lyrics.lines[activeLyricIdx].text]}
                        </div>
                      )}
                      {lyrics.lines[activeLyricIdx + 1] && (
                        <div
                          className={`mt-3 text-white/70 text-center leading-snug [text-shadow:_0_2px_6px_rgba(0,0,0,0.95)] ${
                            lyricsExpanded ? "text-2xl" : "text-lg"
                          }`}
                        >
                          {lyrics.lines[activeLyricIdx + 1].text}
                          {annoOn && annoMap[lyrics.lines[activeLyricIdx + 1].text] && (
                            <div className="text-xs text-white/50 mt-1">{annoMap[lyrics.lines[activeLyricIdx + 1].text]}</div>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="text-white/60 text-lg [text-shadow:_0_2px_4px_rgba(0,0,0,0.95)]">
                      {lyrics?.source === "fallback" ? "(本曲無歌詞)" : "歌詞載入中..."}
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : playing && streamError ? (
            // Stream resolve failed — show why and auto-skip (see effect above).
            <div className="flex-1 flex flex-col items-center justify-center gap-5 p-8 text-center">
              <div className="text-6xl">⚠️</div>
              <div className="text-3xl text-ktv-accent font-bold">無法載入此影片</div>
              <div className="text-lg text-white/70">可能為私人、地區限制或連結失效，即將跳過…</div>
              {playing?.title && <div className="text-white/50 max-w-xl truncate">{playing.title}</div>}
              <button type="button" className="btn-primary" onClick={() => api.playbackNext(roomId).catch(console.error)}>
                立即跳過
              </button>
            </div>
          ) : playing ? (
            // Song is playing but stream/buffer not ready yet — show a loading
            // state instead of the idle splash (which falsely implies an empty room).
            <div className="flex-1 flex flex-col items-center justify-center gap-5 p-8 text-center">
              <div className="text-5xl animate-pulse">🎬</div>
              <div className="text-2xl text-white/70">影片載入中…</div>
              {playing?.title && <div className="text-white/50 max-w-xl truncate">{playing.title}</div>}
            </div>
          ) : (
            // Idle splash — show a giant QR so phones can join without squinting at the sidebar.
            <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8">
              <div className="text-6xl">🎤</div>
              <div className="text-3xl text-ktv-gold font-bold">等待點歌中</div>
              {qrUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrUrl} alt="QR" className="w-72 h-72 rounded-2xl bg-white p-3 shadow-2xl" />
              ) : (
                <div className="w-72 h-72 bg-white/10 rounded-2xl" />
              )}
              <div className="text-xl text-white/70">手機掃描 QR 加入點唱</div>
              {phoneUrl && (
                <div className="text-sm text-white/40 break-all max-w-xl text-center">{phoneUrl}</div>
              )}
              {idleCharts.length > 0 && (
                <div className="mt-6 w-full max-w-md">
                  <div className="text-sm font-bold text-ktv-gold/80 uppercase tracking-widest text-center mb-3">
                    🔥 本包廂熱門點播
                  </div>
                  <ul className="space-y-2">
                    {idleCharts.map((c, i) => (
                      <li
                        key={`${c.video_id}-${i}`}
                        className="flex items-center gap-3 panel px-4 py-2 text-left"
                      >
                        <span className="text-xl font-extrabold text-white/25 w-7 text-center shrink-0">
                          {i + 1}
                        </span>
                        <span className="flex-1 truncate text-white/85">{c.title}</span>
                        <span className="text-sm text-white/40 shrink-0">{c.play_count} 次</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Sidebar */}
        <aside
          className={`fixed right-4 top-20 bottom-4 z-30 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-4 min-h-0 transition-transform duration-200 ${
            queueOpen ? "translate-x-0" : "translate-x-[calc(100%+2rem)]"
          }`}
        >
          <div className="panel p-4 flex flex-col items-center">
            <div className="text-xs text-white/60 mb-2">手機點歌</div>
            {qrUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qrUrl} alt="QR" className="w-44 h-44 rounded-xl" />
            ) : (
              <div className="w-44 h-44 bg-white/10 rounded-xl" />
            )}
            <div className="text-[10px] text-white/40 mt-2 break-all text-center">{phoneUrl}</div>
          </div>
          <div className="panel p-4 flex-1 min-h-0 flex flex-col">
            <div className="text-sm font-bold text-white/80 mb-2">點播清單 ({queue.length})</div>
            <ul className="flex-1 overflow-y-auto space-y-2 pr-1">
              {queue.length === 0 && <li className="text-white/40 text-sm">尚未有人點歌</li>}
              {queue.map((it) => (
                <li
                  key={it.id}
                  className={`bg-white/5 rounded-lg p-2 text-sm ${
                    it.status === "playing" ? "ring-2 ring-ktv-mic" : ""
                  }`}
                >
                  <div className="font-semibold truncate">{it.title}</div>
                  <div className="text-xs text-white/50">
                    @{it.nickname}
                    {it.vocal_mode === "instrumental" && (
                      <span className="ml-2 text-ktv-mic">[消音]</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </main>
  );
}
