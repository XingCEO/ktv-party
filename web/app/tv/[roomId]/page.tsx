"use client";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const [atmosphere, setAtmosphere] = useState<{ kind: any; ts: number } | null>(null);
  const [emojiTrigger, setEmojiTrigger] = useState<{ kind: string; ts: number } | null>(null);
  const [lyricsExpanded, setLyricsExpanded] = useState(false);
  // Sync nudge: positive value makes lyrics appear earlier (compensates intro padding
  // on YouTube uploads vs. lrclib's album-master timing). Re-zeroed per song.
  const [lyricOffsetSec, setLyricOffsetSec] = useState(0);
  const [activeLyricIdx, setActiveLyricIdx] = useState(-1);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const wsRef = useRef<RoomSocket | null>(null);
  const lastVideoIdRef = useRef<string | null>(null);
  const activeIdxRef = useRef(-1);
  const fetchTokenRef = useRef<string | null>(null);

  const playing = useMemo(() => queue.find((q) => q.status === "playing") || null, [queue]);
  const externalAudioUrl = useMemo(() => {
    if (!stream) return null;
    if (playing?.vocal_mode === "instrumental" && stream.instrumental_url) return stream.instrumental_url;
    return stream.audio_url || null;
  }, [stream, playing?.vocal_mode]);

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

  // WebSocket
  useEffect(() => {
    const ws = new RoomSocket(roomId);
    wsRef.current = ws;
    const off = ws.on((m) => {
      if (m.event === "room.snapshot") {
        setQueue(m.data.queue || []);
        setTimer(m.data.timer);
      }
      if (m.event === "queue.added" || m.event === "queue.removed" || m.event === "queue.reordered" || m.event === "playback.advanced") {
        setQueue(m.data.queue || []);
      }
      if (m.event.startsWith("atmosphere.")) {
        const ts = Date.now();
        const kind = m.event.replace("atmosphere.", "") as any;
        setAtmosphere({ kind, ts });
        setEmojiTrigger({ kind: m.event, ts });
      }
      if (m.event === "vocal_removal.ready" && playing && m.data.video_id === playing.video_id) {
        // reload stream to pick up instrumental
        api.getStream(playing.video_id).then(setStream).catch(console.error);
      }
      if (m.event === "room.timer.started" || m.event === "room.timer.reset") {
        setTimer(m.data as RoomTimer);
      }
      if (m.event === "room.snapshot" && m.data.timer) {
        setTimer(m.data.timer);
      }
    });
    ws.connect();
    return () => {
      off();
      ws.close();
    };
  }, [roomId, playing?.video_id]);

  // When playing changes, fetch stream + lyrics. Clear immediately so the
  // previous song's lyrics don't linger, and guard against a late response
  // for the previous song stomping the current one.
  useEffect(() => {
    if (!playing) {
      setStream(null);
      setLyrics(null);
      return;
    }
    setStream(null);
    setLyrics(null);
    const myId = playing.video_id;
    fetchTokenRef.current = myId;
    api.getStream(myId).then((s) => {
      if (fetchTokenRef.current === myId) setStream(s);
    }).catch(console.error);
    api.getLyrics(myId, playing.title).then((l) => {
      if (fetchTokenRef.current === myId) setLyrics(l);
    }).catch(console.error);
  }, [playing?.video_id, playing?.title]);

  // Auto-attach ended handler. (currentTime is read in the rAF tick below, not
  // via timeupdate, since timeupdate only fires ~4Hz on most browsers.)
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    const onEnded = async () => {
      await api.playbackNext(roomId).catch(console.error);
    };
    v.addEventListener("ended", onEnded);
    return () => v.removeEventListener("ended", onEnded);
  }, [stream, roomId]);

  // Drive video src imperatively so re-fetched stream URLs (mid-song refresh)
  // can keep currentTime instead of yanking the singer back to t=0.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    const sameSong = lastVideoIdRef.current === stream.video_id;
    const resumeAt = sameSong ? v.currentTime : 0;
    const wasPlaying = sameSong && !v.paused;
    v.src = stream.video_url;
    const onLoaded = () => {
      if (resumeAt > 0.5) v.currentTime = resumeAt;
      if (wasPlaying || !sameSong) v.play().catch(() => {});
    };
    v.addEventListener("loadedmetadata", onLoaded, { once: true });
    lastVideoIdRef.current = stream.video_id;
    return () => v.removeEventListener("loadedmetadata", onLoaded);
  }, [stream?.video_url, stream?.video_id]);

  // Same trick for the external audio track when present.
  useEffect(() => {
    const a = audioRef.current;
    const v = videoRef.current;
    if (!a || !externalAudioUrl) return;
    const resumeAt = v ? v.currentTime : 0;
    a.src = externalAudioUrl;
    const onLoaded = () => {
      if (resumeAt > 0.5) a.currentTime = resumeAt;
      if (v && !v.paused) a.play().catch(() => {});
    };
    a.addEventListener("loadedmetadata", onLoaded, { once: true });
    return () => a.removeEventListener("loadedmetadata", onLoaded);
  }, [externalAudioUrl]);

  // Stream URLs from yt-dlp expire (typ. ~6h). Re-fetch shortly before expiry so
  // long-running playback / idle TV doesn't break with a 403 mid-song.
  useEffect(() => {
    if (!playing || !stream?.expires_at) return;
    const refreshAtMs = Math.max(5_000, (stream.expires_at - 600) * 1000 - Date.now());
    const t = setTimeout(() => {
      api.getStream(playing.video_id).then(setStream).catch(console.error);
    }, refreshAtMs);
    return () => clearTimeout(t);
  }, [stream?.expires_at, playing?.video_id]);

  // Recover from forbidden / network errors on the video element by re-fetching the stream.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !playing) return;
    const onError = () => {
      // MediaError code 4 = MEDIA_ERR_SRC_NOT_SUPPORTED, often the symptom of an expired CDN URL.
      api.getStream(playing.video_id).then(setStream).catch(console.error);
    };
    v.addEventListener("error", onError);
    return () => v.removeEventListener("error", onError);
  }, [playing?.video_id]);

  // Mute video when an external audio track is in use (split DASH or instrumental)
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !!externalAudioUrl;
  }, [externalAudioUrl]);

  // Sync external audio track with video time (DASH split streams or instrumental)
  useEffect(() => {
    const v = videoRef.current;
    const a = audioRef.current;
    if (!v || !a || !externalAudioUrl) return;
    const sync = () => {
      if (Math.abs(a.currentTime - v.currentTime) > 0.1) a.currentTime = v.currentTime;
    };
    const onPlay = () => a.play().catch(() => {});
    const onPause = () => a.pause();
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeked", sync);
    const tick = setInterval(sync, 500);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", sync);
      clearInterval(tick);
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
  }, [timer?.started_at, timer?.rate_per_minute]);

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
  }, [lyrics, playing?.video_id, lyricOffsetSec]);

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
  }, [playing?.video_id]);

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

  return (
    <main className="min-h-screen flex flex-col bg-ktv-bg text-white">
      <Atmosphere trigger={atmosphere} />
      <FloatingEmoji trigger={emojiTrigger} />

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
          {!timer?.started_at ? (
            <button className="btn-primary" onClick={startTimer}>開始計費</button>
          ) : (
            <button className="btn-ghost" onClick={resetTimer}>重置</button>
          )}
          <button className="btn-ghost" onClick={skipSong}>下一首</button>
          <button
            className="btn-ghost"
            onClick={() => setLyricsExpanded((v) => !v)}
            title="切換歌詞大小"
          >
            {lyricsExpanded ? "縮小歌詞" : "放大歌詞"}
          </button>
          {playing && (
            <button
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
              <button className="btn-ghost px-2" onClick={() => nudgeOffset(-1.0)} title="歌詞慢 1 秒">
                ⏮
              </button>
              <button className="btn-ghost px-2" onClick={() => nudgeOffset(-0.3)} title="歌詞慢 0.3 秒">
                ⏪
              </button>
              <span className="font-mono text-xs text-ktv-gold w-14 text-center">
                {lyricOffsetSec >= 0 ? "+" : ""}{lyricOffsetSec.toFixed(1)}s
              </span>
              <button className="btn-ghost px-2" onClick={() => nudgeOffset(0.3)} title="歌詞快 0.3 秒">
                ⏩
              </button>
              <button className="btn-ghost px-2" onClick={() => nudgeOffset(1.0)} title="歌詞快 1 秒">
                ⏭
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {/* Main grid */}
      <div className="flex-1 grid grid-cols-12 gap-4 p-4 min-h-0">
        {/* Video + lyrics */}
        <section className="col-span-9 panel overflow-hidden flex flex-col min-h-0">
          {playing && stream ? (
            <>
              <div className="relative bg-black flex-1 min-h-0">
                {/* src is set imperatively in an effect so URL refreshes don't reset currentTime */}
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  // Set muted via JSX prop so the autoplay attempt sees the right
                  // value at first paint — setting it later via an effect was
                  // racing the autoplay policy and could leave the element paused.
                  muted={!!externalAudioUrl}
                  className="w-full h-full object-contain"
                />
                {externalAudioUrl && (
                  <audio ref={audioRef} preload="auto" />
                )}
                <div className="absolute top-4 left-4 panel px-3 py-1 text-sm">
                  <span className="text-ktv-gold font-bold">{playing.title}</span>
                  <span className="text-white/60 ml-2">@{playing.nickname}</span>
                  {playing.vocal_mode === "instrumental" && (
                    <span className="ml-2 pill bg-ktv-mic text-black">伴奏</span>
                  )}
                </div>
                {/* Lyrics overlaid on the video — KTV-style. Gradient backdrop keeps text
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
                            {lyrics.lines[activeLyricIdx].text}
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
                      {lyrics.lines[activeLyricIdx + 1] && (
                        <div
                          className={`mt-3 text-white/70 text-center leading-snug [text-shadow:_0_2px_6px_rgba(0,0,0,0.95)] ${
                            lyricsExpanded ? "text-2xl" : "text-lg"
                          }`}
                        >
                          {lyrics.lines[activeLyricIdx + 1].text}
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
            </div>
          )}
        </section>

        {/* Sidebar */}
        <aside className="col-span-3 flex flex-col gap-4 min-h-0">
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
