"use client";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { api, fmtDuration, type QueueItem, type SearchResult } from "@/lib/api";
import { ensureIdentity, getIdentity } from "@/lib/identity";
import { RoomSocket } from "@/lib/ws";
import { cn } from "@/lib/cn";
import { isEqualQueue } from "@/lib/compare";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { IconButton } from "@/components/ui/IconButton";
import { Spinner } from "@/components/ui/Spinner";
import { motion, AnimatePresence } from "framer-motion";

function PhonePageContent() {
  const params = useParams<{ roomId: string }>();
  const roomId = params.roomId;
  const [nickname, setNickname] = useState("");
  const [confirmedNick, setConfirmedNick] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [vocalMode, setVocalMode] = useState<"original" | "instrumental">("original");
  const [reconnecting, setReconnecting] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  
  const wsRef = useRef<RoomSocket | null>(null);
  const toast = useToast();

  // Restore nickname
  useEffect(() => {
    const id = getIdentity();
    if (id) {
      setNickname(id.nickname);
      setConfirmedNick(id.nickname);
    }
  }, []);

  const handleQueueUpdate = useCallback((newQueue: QueueItem[]) => {
    setQueue(prev => isEqualQueue(prev, newQueue) ? prev : newQueue);
  }, []);

  // Load + subscribe
  useEffect(() => {
    if (!confirmedNick) return;
    
    api.getQueue(roomId).then(handleQueueUpdate).catch((e) => toast({ variant: "error", message: e.message || "讀取播放清單失敗" }));
    
    const ws = new RoomSocket(roomId);
    wsRef.current = ws;

    const off = ws.on((m) => {
      if (m.event === "room.snapshot") {
        handleQueueUpdate(m.data.queue || []);
      }
      if (m.event === "queue.added" || m.event === "queue.removed" || m.event === "queue.reordered" || m.event === "playback.advanced" || m.event === "queue.vocal_mode.updated") {
        handleQueueUpdate(m.data.queue || []);
      }
      if (m.event === "vocal_removal.ready") {
        toast({ variant: "success", title: "✨ 消音完成", message: `已準備好伴奏: ${m.data.video_id}` });
      }
    });

    // Wire connection state -> reconnecting indicator. Show "重連中..." while
    // RoomSocket is in connecting/reconnecting; clear on first successful open.
    const offState = ws.onState((state) => {
      setReconnecting(state === "reconnecting" || state === "connecting");
    });

    ws.connect();
    return () => {
      off();
      offState();
      ws.close();
    };
  }, [roomId, confirmedNick, handleQueueUpdate, toast]);

  const joinRoom = useCallback(() => {
    const n = nickname.trim();
    if (!n) {
      toast({ variant: "warning", message: "請輸入暱稱" });
      return;
    }
    ensureIdentity(n);
    setConfirmedNick(n);
  }, [nickname, toast]);

  const doSearch = useCallback(async () => {
    if (!q.trim()) return;
    setSearching(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    try {
      setResults(await api.search(q.trim(), 12));
    } catch (e: any) {
      toast({ variant: "error", message: e.message || "搜尋失敗" });
    } finally {
      setSearching(false);
    }
  }, [q, toast]);

  const addSong = useCallback(async (s: SearchResult) => {
    if (!confirmedNick || addingId) return;
    setAddingId(s.video_id);
    try {
      const id = getIdentity();
      await api.addToQueue(roomId, {
        video_id: s.video_id,
        title: s.title,
        duration_sec: s.duration_sec,
        thumbnail_url: s.thumbnail_url,
        channel: s.channel,
        nickname: confirmedNick,
        user_id: id?.user_id,
        vocal_mode: vocalMode,
      });
      toast({ variant: "success", message: `✓ 已加入 - ${s.title}` });
    } catch (e: any) {
      toast({ variant: "error", message: e.message || "點播失敗" });
    } finally {
      setTimeout(() => setAddingId(null), 200);
    }
  }, [confirmedNick, roomId, vocalMode, addingId, toast]);

  const isMine = useCallback((item: QueueItem): boolean => {
    const myId = getIdentity()?.user_id;
    if (myId && item.user_id) return item.user_id === myId;
    return item.nickname === confirmedNick;
  }, [confirmedNick]);

  const removeSong = useCallback(async (item: QueueItem) => {
    if (!isMine(item)) return;
    if (!confirm(`確定要從點播清單移除「${item.title}」嗎？`)) return;
    try {
      await api.removeQueueItem(roomId, item.id);
    } catch (e: any) {
      toast({ variant: "error", message: e.message || "移除失敗" });
    }
  }, [isMine, roomId, toast]);

  const sendAtmosphere = useCallback((kind: "confetti" | "fireworks" | "clap" | "birthday") => {
    wsRef.current?.send(`atmosphere.${kind}`, { from: confirmedNick, ts: Date.now() });
  }, [confirmedNick]);

  const myCount = useMemo(
    () => queue.filter((x) => x.status !== "done" && isMine(x)).length,
    [queue, isMine],
  );

  const myQueueItems = useMemo(() => queue.filter(x => isMine(x)), [queue, isMine]);

  const playing = useMemo(() => queue.find((q) => q.status === "playing") || null, [queue]);
  const isSinger = useMemo(() => {
    if (!playing) return false;
    const myId = getIdentity()?.user_id;
    if (myId && playing.user_id) return playing.user_id === myId;
    return playing.nickname === confirmedNick;
  }, [playing, confirmedNick]);

  const prevSingerRef = useRef<boolean>(false);
  useEffect(() => {
    if (isSinger && !prevSingerRef.current) {
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate([200, 100, 200]);
      }
    } else if (!isSinger && prevSingerRef.current) {
      toast({ variant: "success", message: "🎉 演唱結束！" });
    }
    prevSingerRef.current = isSinger;
  }, [isSinger, toast]);

  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (!isSinger) {
      setElapsedSec(0);
      return;
    }
    const t = setInterval(() => setElapsedSec(prev => prev + 1), 1000);
    return () => clearInterval(t);
  }, [isSinger, playing?.id]);

  const [localOffset, setLocalOffset] = useState<number>(0);
  useEffect(() => {
    if (playing?.video_id && typeof window !== "undefined") {
      const raw = window.localStorage.getItem(`ktv-lyric-offset-${playing.video_id}`);
      setLocalOffset(raw ? Number(raw) || 0 : 0);
    }
  }, [playing?.video_id]);

  const nudgeLyric = useCallback((delta: number) => {
    if (!playing) return;
    setLocalOffset((v) => {
      const next = Math.round((v + delta) * 10) / 10;
      try { window.localStorage.setItem(`ktv-lyric-offset-${playing.video_id}`, String(next)); } catch {}
      wsRef.current?.send("lyric.nudge", { item_id: playing.id, delta_sec: delta });
      return next;
    });
  }, [playing]);

  const toggleSingerVocalMode = useCallback(async (mode: "original" | "instrumental") => {
    if (!playing) return;
    try {
      await api.setVocalMode(roomId, playing.id, mode);
    } catch (e: any) {
      toast({ variant: "error", message: e.message || "切換失敗" });
    }
  }, [playing, roomId, toast]);

  const skipMySong = useCallback(async () => {
    if (!playing) return;
    if (confirm("確定要跳過下一首嗎？")) {
      try {
        await api.playbackNext(roomId);
      } catch (e: any) {
        toast({ variant: "error", message: e.message || "跳過失敗" });
      }
    }
  }, [playing, roomId, toast]);


  if (!confirmedNick) {
    return (
      <main className="min-h-screen bg-ktv-bg flex flex-col items-center justify-center p-6 relative overflow-hidden">
        <div className="absolute top-0 right-0 p-40 bg-pink-gold/20 rounded-full blur-[100px] -z-10 pointer-events-none animate-breathe" />
        <div className="absolute bottom-0 left-0 p-40 bg-ktv-accent/10 rounded-full blur-[100px] -z-10 pointer-events-none" />
        
        <Badge variant="outline" className="absolute top-6 left-1/2 -translate-x-1/2 bg-white/5 backdrop-blur-md">
          包廂 {roomId}
        </Badge>

        <Card glow className="w-full max-w-sm border-white/10 bg-panel/80 backdrop-blur-xl">
          <CardBody className="p-8 flex flex-col items-center text-center">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-ktv-gold to-ktv-accent flex items-center justify-center text-3xl mb-6 shadow-glow">
              🎤
            </div>
            <h1 className="text-3xl font-extrabold mb-2 text-transparent bg-clip-text bg-gradient-to-br from-white to-white/70">
              KTV Box
            </h1>
            <p className="text-sm text-white/50 mb-8">請輸入暱稱以加入點歌</p>
            
            <div className="w-full relative">
              <Input
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="你的暱稱"
                className="w-full text-center text-lg h-14 bg-white/5 border-white/10"
                maxLength={20}
                onKeyDown={(e) => e.key === "Enter" && joinRoom()}
              />
            </div>
            <Button onClick={joinRoom} className="w-full h-14 text-lg mt-6 shadow-neon" variant="primary">
              進入包廂
            </Button>
          </CardBody>
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-screen pb-[120px] bg-ktv-bg flex flex-col text-white">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-ktv-bg/80 backdrop-blur-xl border-b border-white/10 shadow-sm transition-all">
        <div className="px-4 py-3 flex items-center justify-between safe-top">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-white/15 bg-white/5 text-white/60">
                包廂 {roomId}
              </Badge>
              {reconnecting && (
                <Badge variant="accent" className="text-[10px] px-1.5 py-0 animate-pulse text-white bg-ktv-accent/80">
                  重連中...
                </Badge>
              )}
            </div>
            <div className="font-bold text-base flex items-center gap-2">
              {confirmedNick}
              {myCount > 0 && (
                <Badge variant="accent" className="px-1.5 py-0 text-[11px] h-5 rounded-full flex items-center justify-center">
                  我的點播 {myCount}
                </Badge>
              )}
            </div>
          </div>
          <IconButton
            icon={<span className="text-xl">🔄</span>}
            aria-label="切換暱稱"
            variant="ghost"
            onClick={() => {
              localStorage.removeItem("ktv-identity-v1");
              setConfirmedNick(null);
            }}
          />
        </div>
      </header>

      
      {isSinger && playing && (
        <section className="px-4 pt-6">
          <div className="bg-gradient-to-r from-ktv-gold/20 via-ktv-accent/20 to-ktv-gold/20 p-1 rounded-2xl animate-breathe shadow-glow">
            <Card className="bg-panel/90 backdrop-blur-xl border-white/10 p-4">
              <div className="flex justify-between items-center mb-3">
                <div className="text-ktv-gold font-black tracking-widest">🎤 你的場！</div>
                <Badge variant="gold" className="font-mono text-sm shadow-glow">
                  {fmtDuration(Math.max(0, (playing.duration_sec || 0) - elapsedSec))}
                </Badge>
              </div>
              <div className="font-bold text-lg mb-4 truncate text-white drop-shadow-md">{playing.title}</div>
              
              <div className="flex flex-col gap-3">
                {/* Vocal Toggle */}
                <div className="flex bg-white/5 p-1 rounded-xl border border-white/5 relative">
                  <button
                    className={cn("flex-1 py-2 text-sm font-bold rounded-lg transition-colors", playing.vocal_mode === "original" ? "bg-ktv-gold text-ktv-bg shadow-md" : "text-white/70")}
                    onClick={() => toggleSingerVocalMode("original")}
                  >
                    🎵 原唱
                  </button>
                  <button
                    className={cn("flex-1 py-2 text-sm font-bold rounded-lg transition-colors", playing.vocal_mode === "instrumental" ? "bg-ktv-mic text-ktv-bg shadow-md" : "text-white/70")}
                    onClick={() => toggleSingerVocalMode("instrumental")}
                  >
                    🎤 伴奏
                  </button>
                </div>

                {/* Lyric Offset */}
                <div className="flex items-center justify-between bg-white/5 p-2 rounded-xl border border-white/5">
                  <span className="text-xs text-white/50 ml-2">歌詞微調</span>
                  <div className="flex items-center gap-1">
                    <IconButton variant="ghost" aria-label="-1s" icon={<span className="text-xs">-1s</span>} onClick={() => nudgeLyric(-1)} className="w-8 h-8 rounded-full" />
                    <IconButton variant="ghost" aria-label="-0.3s" icon={<span className="text-xs">-0.3s</span>} onClick={() => nudgeLyric(-0.3)} className="w-8 h-8 rounded-full" />
                    <span className="font-mono text-xs w-12 text-center text-ktv-gold">{localOffset > 0 ? "+" : ""}{localOffset.toFixed(1)}s</span>
                    <IconButton variant="ghost" aria-label="+0.3s" icon={<span className="text-xs">+0.3s</span>} onClick={() => nudgeLyric(0.3)} className="w-8 h-8 rounded-full" />
                    <IconButton variant="ghost" aria-label="+1s" icon={<span className="text-xs">+1s</span>} onClick={() => nudgeLyric(1)} className="w-8 h-8 rounded-full" />
                  </div>
                </div>

                {/* Skip */}
                <Button variant="danger" className="w-full mt-1" onClick={skipMySong}>
                  跳過下一首
                </Button>
              </div>
            </Card>
          </div>
        </section>
      )}

      {/* Search */}
      <section className="px-4 pt-6 flex flex-col gap-4">
        <div className="flex gap-2 relative">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜尋歌曲 / 歌手"
            className="flex-1 h-12 bg-white/5 border-white/10 pr-12 focus:bg-white/10 transition-colors"
            onKeyDown={(e) => e.key === "Enter" && doSearch()}
            leftIcon={<span className="text-white/40 ml-2">🔍</span>}
          />
          <Button onClick={doSearch} className="h-12 px-6 shadow-md" disabled={searching}>
            {searching ? <Spinner size="sm" /> : "搜尋"}
          </Button>
        </div>

        {!isSinger && (
          <div className="flex bg-white/5 p-1 rounded-xl border border-white/5 relative">
          <div className="flex-1 relative z-10">
            <button
              className={cn(
                "w-full py-2 text-sm font-bold rounded-lg transition-colors relative",
                vocalMode === "original" ? "text-ktv-bg" : "text-white/70"
              )}
              onClick={() => setVocalMode("original")}
            >
              {vocalMode === "original" && (
                <motion.div
                  layoutId="vocalMode"
                  className="absolute inset-0 bg-ktv-gold rounded-lg shadow-md -z-10"
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                />
              )}
              <span className="relative z-10">🎵 原唱</span>
            </button>
          </div>
          <div className="flex-1 relative z-10">
            <button
              className={cn(
                "w-full py-2 text-sm font-bold rounded-lg transition-colors relative",
                vocalMode === "instrumental" ? "text-ktv-bg" : "text-white/70"
              )}
              onClick={() => setVocalMode("instrumental")}
            >
              {vocalMode === "instrumental" && (
                <motion.div
                  layoutId="vocalMode"
                  className="absolute inset-0 bg-ktv-mic rounded-lg shadow-md -z-10"
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                />
              )}
              <span className="relative z-10">🎤 消音 (伴奏)</span>
            </button>
          </div>
        </div>
        )}
      </section>

      {/* Search results */}
      <AnimatePresence>
        {results.length > 0 && (
          <motion.section 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="px-4 mt-8"
          >
            <h2 className="text-sm font-bold text-white/50 mb-3 uppercase tracking-wider flex items-center gap-2">
              <span className="w-4 h-[1px] bg-white/20"></span>
              搜尋結果
            </h2>
            <ul className="space-y-3">
              {results.map((r, i) => (
                <motion.li 
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  key={r.video_id}
                >
                  <Card className="bg-panel border-white/5 hover:border-white/20 transition-colors p-3 flex gap-3 items-center group overflow-hidden">
                    <div className="relative shrink-0">
                      {r.thumbnail_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.thumbnail_url} alt="" className="w-20 h-[4.5rem] rounded-lg object-cover bg-white/5" />
                      ) : (
                        <div className="w-20 h-[4.5rem] bg-white/10 rounded-lg flex items-center justify-center">
                          <span className="text-2xl opacity-20">🎵</span>
                        </div>
                      )}
                      <div className="absolute bottom-1 right-1 bg-black/80 px-1.5 py-0.5 rounded text-[10px] font-bold">
                        {fmtDuration(r.duration_sec)}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0 pr-2">
                      <div className="font-bold truncate text-sm mb-1 leading-snug">{r.title}</div>
                      <div className="text-xs text-white/50 truncate flex items-center gap-1">
                        <span className="opacity-60">👤</span>
                        {r.channel || "未知"}
                      </div>
                    </div>
                    <Button 
                      onClick={() => addSong(r)} 
                      variant="primary" 
                      size="sm"
                      loading={addingId === r.video_id}
                      className="shrink-0 shadow-lg shadow-ktv-accent/20"
                    >
                      點播
                    </Button>
                  </Card>
                </motion.li>
              ))}
            </ul>
          </motion.section>
        )}
      </AnimatePresence>

      {/* Queue */}
      <section className="px-4 mt-10 mb-8">
        <h2 className="text-sm font-bold text-white/50 mb-3 uppercase tracking-wider flex items-center gap-2">
          <span className="w-4 h-[1px] bg-white/20"></span>
          點播清單
        </h2>
        {queue.length === 0 ? (
          <div className="py-12 flex flex-col items-center justify-center bg-white/5 rounded-2xl border border-white/5 border-dashed text-center">
            <div className="text-5xl mb-3 opacity-60 animate-breathe">🎵</div>
            <div className="text-white/60 font-medium">尚未有人點歌</div>
            <div className="text-white/40 text-xs mt-1">下拉重新整理或在上方搜尋</div>
          </div>
        ) : (
          <ul className="space-y-3">
            <AnimatePresence mode="popLayout">
              {queue.map((it) => (
                <motion.li
                  layout
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  key={it.id}
                >
                  <Card className={cn(
                    "border-white/5 transition-all relative overflow-hidden",
                    it.status === "playing" ? "bg-gradient-to-r from-ktv-mic/20 to-panel border-ktv-mic/30 shadow-[0_0_15px_rgba(6,214,160,0.15)]" : "bg-panel"
                  )}>
                    {it.status === "playing" && (
                      <div className="absolute left-0 top-0 bottom-0 w-1 bg-ktv-mic animate-pulse" />
                    )}
                    <CardBody className="p-3 flex items-center gap-3">
                      <div className="w-10 flex shrink-0 justify-center">
                        {it.status === "playing" ? (
                          <div className="w-8 h-8 rounded-full bg-ktv-mic/20 text-ktv-mic flex items-center justify-center shadow-lg shadow-ktv-mic/20 text-sm">
                            <span className="ml-[2px]">▶</span>
                          </div>
                        ) : (
                          <div className="text-xl font-bold text-white/20">
                            {it.position}
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0 pr-2">
                        <div className={cn(
                          "font-bold truncate text-sm leading-snug mb-1",
                          it.status === "playing" ? "text-white" : "text-white/90"
                        )}>
                          {it.title}
                        </div>
                        <div className="flex items-center flex-wrap gap-2 text-[11px] text-white/50">
                          <span className={cn(
                            "px-1.5 py-0.5 rounded flex items-center gap-1",
                            isMine(it) ? "bg-white/10 text-white/90 font-medium" : "bg-transparent"
                          )}>
                            @{it.nickname}
                          </span>
                          <span>· {fmtDuration(it.duration_sec)}</span>
                          {it.vocal_mode === "instrumental" && (
                            <Badge variant="mic" className="px-1.5 py-0 text-[9px] h-4">消音</Badge>
                          )}
                        </div>
                      </div>
                      {isMine(it) && it.status !== "playing" && (
                        <IconButton
                          icon={<span className="text-sm">✕</span>}
                          aria-label="移除點播"
                          variant="ghost"
                          className="text-white/30 hover:text-ktv-accent hover:bg-ktv-accent/10 shrink-0"
                          onClick={() => removeSong(it)}
                        />
                      )}
                    </CardBody>
                  </Card>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </section>

      {/* Atmosphere bar */}
      <nav className="fixed bottom-0 inset-x-0 z-30 bg-ktv-panel/90 backdrop-blur-xl border-t border-white/10 pt-3 pb-safe-bottom shadow-[0_-10px_40px_rgba(0,0,0,0.5)]">
        <div className="flex justify-around max-w-sm mx-auto px-4 relative pb-3">
          <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-2 bg-ktv-panel text-[10px] text-white/40 uppercase tracking-widest font-bold rounded-full">氣氛特效</div>
          
          <button 
            onClick={() => sendAtmosphere("clap")} 
            className="w-14 h-14 rounded-full bg-white/5 hover:bg-white/10 active:scale-90 active:bg-white/20 transition-all flex items-center justify-center text-2xl shadow-lg border border-white/5 group"
            aria-label="拍手"
          >
            <span className="group-hover:-translate-y-1 transition-transform">👏</span>
          </button>
          <button 
            onClick={() => sendAtmosphere("confetti")} 
            className="w-14 h-14 rounded-full bg-white/5 hover:bg-white/10 active:scale-90 active:bg-white/20 transition-all flex items-center justify-center text-2xl shadow-lg border border-white/5 group"
            aria-label="彩帶"
          >
            <span className="group-hover:-translate-y-1 transition-transform">🎊</span>
          </button>
          <button 
            onClick={() => sendAtmosphere("fireworks")} 
            className="w-14 h-14 rounded-full bg-white/5 hover:bg-white/10 active:scale-90 active:bg-white/20 transition-all flex items-center justify-center text-2xl shadow-lg border border-white/5 group"
            aria-label="煙火"
          >
            <span className="group-hover:-translate-y-1 transition-transform">🎆</span>
          </button>
          <button 
            onClick={() => sendAtmosphere("birthday")} 
            className="w-14 h-14 rounded-full bg-white/5 hover:bg-white/10 active:scale-90 active:bg-white/20 transition-all flex items-center justify-center text-2xl shadow-lg border border-white/5 group"
            aria-label="生日"
          >
            <span className="group-hover:-translate-y-1 transition-transform">🎂</span>
          </button>
        </div>
      </nav>
    </main>
  );
}

export default function PhonePage() {
  return (
    <ToastProvider>
      <PhonePageContent />
    </ToastProvider>
  );
}
