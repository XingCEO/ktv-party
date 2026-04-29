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
  const [videoTime, setVideoTime] = useState(0);
  const [atmosphere, setAtmosphere] = useState<{ kind: any; ts: number } | null>(null);
  const [emojiTrigger, setEmojiTrigger] = useState<{ kind: string; ts: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const wsRef = useRef<RoomSocket | null>(null);

  const playing = useMemo(() => queue.find((q) => q.status === "playing") || null, [queue]);

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
    });
    ws.connect();
    return () => {
      off();
      ws.close();
    };
  }, [roomId, playing?.video_id]);

  // When playing changes, fetch stream + lyrics
  useEffect(() => {
    if (!playing) {
      setStream(null);
      setLyrics(null);
      return;
    }
    api.getStream(playing.video_id).then(setStream).catch(console.error);
    api.getLyrics(playing.video_id, playing.title).then(setLyrics).catch(console.error);
  }, [playing?.video_id, playing?.title]);

  // Auto-attach video element + handle ended event + drive lyric time
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    const onEnded = async () => {
      await api.playbackNext(roomId).catch(console.error);
    };
    const onTime = () => setVideoTime(v.currentTime);
    v.addEventListener("ended", onEnded);
    v.addEventListener("timeupdate", onTime);
    return () => {
      v.removeEventListener("ended", onEnded);
      v.removeEventListener("timeupdate", onTime);
    };
  }, [stream, roomId]);

  // Mute video when instrumental mode is active and instrumental is available
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const wantInstrumental = playing?.vocal_mode === "instrumental" && !!stream?.instrumental_url;
    v.muted = wantInstrumental;
  }, [playing?.vocal_mode, stream?.instrumental_url]);

  // Sync audio (instrumental) playback with video time
  useEffect(() => {
    const v = videoRef.current;
    const a = audioRef.current;
    if (!v || !a || !stream?.instrumental_url) return;
    const sync = () => {
      if (Math.abs(a.currentTime - v.currentTime) > 0.3) a.currentTime = v.currentTime;
    };
    const onPlay = () => a.play().catch(() => {});
    const onPause = () => a.pause();
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeked", sync);
    const tick = setInterval(sync, 1500);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", sync);
      clearInterval(tick);
    };
  }, [stream?.instrumental_url]);

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

  // Determine active lyric line (driven by video timeupdate, not the 1Hz cost ticker)
  const activeLyricIdx = useMemo(() => {
    if (!lyrics?.lines.length) return -1;
    let idx = -1;
    for (let i = 0; i < lyrics.lines.length; i++) {
      if (lyrics.lines[i].time <= videoTime) idx = i;
      else break;
    }
    return idx;
  }, [lyrics, videoTime]);

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
        </div>
      </header>

      {/* Main grid */}
      <div className="flex-1 grid grid-cols-12 gap-4 p-4 min-h-0">
        {/* Video + lyrics */}
        <section className="col-span-9 panel overflow-hidden flex flex-col min-h-0">
          {playing && stream ? (
            <>
              <div className="relative bg-black flex-1 min-h-0">
                <video
                  ref={videoRef}
                  src={stream.video_url}
                  autoPlay
                  controls
                  playsInline
                  className="w-full h-full object-contain"
                />
                {stream.instrumental_url && playing.vocal_mode === "instrumental" && (
                  <audio ref={audioRef} src={stream.instrumental_url} preload="auto" />
                )}
                <div className="absolute top-4 left-4 panel px-3 py-1 text-sm">
                  <span className="text-ktv-gold font-bold">{playing.title}</span>
                  <span className="text-white/60 ml-2">@{playing.nickname}</span>
                  {playing.vocal_mode === "instrumental" && (
                    <span className="ml-2 pill bg-ktv-mic text-black">伴奏</span>
                  )}
                </div>
              </div>
              {/* Lyrics */}
              <div className="h-40 overflow-hidden border-t border-white/5 bg-black/40 px-6 py-3 flex flex-col items-center justify-center">
                {lyrics?.lines.length ? (
                  <AnimatePresence mode="popLayout">
                    {lyrics.lines.slice(Math.max(0, activeLyricIdx - 1), activeLyricIdx + 3).map((l, i) => (
                      <motion.div
                        key={l.time + l.text}
                        initial={{ opacity: 0, y: 30 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        transition={{ duration: 0.3 }}
                        className={`lyric-line ${i === 1 || (activeLyricIdx === 0 && i === 0) ? "active" : ""}`}
                      >
                        {l.text}
                      </motion.div>
                    ))}
                  </AnimatePresence>
                ) : (
                  <div className="text-white/40">
                    {lyrics?.source === "fallback" ? "(本曲無歌詞)" : "歌詞載入中..."}
                  </div>
                )}
              </div>
            </>
          ) : (
            // Idle splash
            <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8">
              <div className="text-6xl">🎤</div>
              <div className="text-2xl text-white/70">等待點歌中...</div>
              <div className="text-white/50">用手機掃描右側 QR 即可加入點唱</div>
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
