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
import { DiscoverPanel, type DiscoverItem } from "@/components/discover/DiscoverPanel";
import { motion, AnimatePresence } from "framer-motion";

function PhonePageContent() {
  const params = useParams<{ roomId: string }>();
  const roomId = params.roomId;
  const [nickname, setNickname] = useState("");
  const [confirmedNick, setConfirmedNick] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [vocalMode, setVocalMode] = useState<"original" | "instrumental">("original");
  const [performanceMode, setPerformanceMode] = useState<"solo" | "duet" | "chorus">("solo");
  const [participants, setParticipants] = useState<Array<{ nickname?: string; user_id?: string }>>([]);
  const [duetPartnerId, setDuetPartnerId] = useState("");
  const [dedicateTo, setDedicateTo] = useState("");
  const [reconnecting, setReconnecting] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [chatText, setChatText] = useState("");
  
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
        setParticipants(m.data.participants || []);
      }
      if (m.event === "presence.updated") {
        setParticipants(m.data.participants || []);
      }
      if (m.event === "queue.added" || m.event === "queue.removed" || m.event === "queue.reordered" || m.event === "playback.advanced" || m.event === "queue.vocal_mode.updated") {
        handleQueueUpdate(m.data.queue || []);
      }
      if (m.event === "insert_top") {
        handleQueueUpdate(m.data.queue || []);
        if (m.data?.message) toast({ variant: "success", message: String(m.data.message) });
      }
      if (m.event === "vote_skip") {
        toast({ variant: "warning", message: `投票切歌 ${m.data.votes}/${m.data.threshold}` });
      }
      if (m.event === "chat.message" && m.data?.kind === "emoji") {
        toast({ variant: "success", message: `${m.data.nickname}: ${m.data.message}` });
      }
      if (m.event === "vocal_removal.ready") {
        toast({ variant: "success", title: "✨ 消音完成", message: `已準備好伴奏: ${m.data.video_id}` });
      }
    });

    // Wire connection state -> reconnecting indicator. Show "重連中..." while
    // RoomSocket is in connecting/reconnecting; clear on first successful open.
    const offState = ws.onState((state) => {
      setReconnecting(state === "reconnecting" || state === "connecting");
      if (state === "open") {
        const identity = getIdentity();
        if (identity) {
          ws.send("identity", identity);
        }
      }
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
    setHasSearched(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    try {
      setResults(await api.search(q.trim(), 12));
    } catch (e: any) {
      toast({ variant: "error", message: e.message || "搜尋失敗" });
    } finally {
      setSearching(false);
    }
  }, [q, toast]);

  // Self-contained: handles its own errors so every caller (search results AND
  // the Discover panel) is safe — a failed add toasts instead of throwing an
  // unhandled rejection or silently doing nothing.
  const addByVideo = useCallback(async (it: DiscoverItem | SearchResult) => {
    if (!confirmedNick) return;
    const id = getIdentity();
    // Duet requires a partner — the backend rejects a duet add without one.
    let duetPartner: { user_id: string; nickname: string } | null = null;
    if (performanceMode === "duet") {
      const p = participants.find((x) => x.user_id === duetPartnerId);
      if (!p?.user_id) {
        toast({ variant: "warning", message: "對唱請先選擇一位夥伴" });
        return;
      }
      duetPartner = { user_id: p.user_id, nickname: p.nickname || "夥伴" };
    }
    try {
      let target: { video_id: string; title: string; duration_sec?: number | null; thumbnail_url?: string | null; channel?: string | null } = it;
      // External chart entries carry a placeholder id (apple:idx:title) and aren't
      // playable — resolve to a real YouTube hit before queueing.
      if (it.video_id.startsWith("apple:")) {
        const resolved = await api.resolveChart(it.title, it.channel ?? undefined);
        if (!resolved) {
          toast({ variant: "warning", message: `找不到可播放的版本 - ${it.title}` });
          return;
        }
        target = resolved;
      }
      await api.addToQueue(roomId, {
        video_id: target.video_id,
        title: target.title,
        duration_sec: target.duration_sec ?? null,
        thumbnail_url: target.thumbnail_url ?? null,
        channel: target.channel ?? null,
        nickname: confirmedNick,
        user_id: id?.user_id,
        vocal_mode: vocalMode,
        performance_mode: performanceMode,
        duet_partner_user_id: duetPartner?.user_id ?? null,
        duet_partner_nickname: duetPartner?.nickname ?? null,
        dedicate_to_nickname: dedicateTo || null,
      });
      toast({ variant: "success", message: `✓ 已加入 - ${target.title}` });
    } catch (e: any) {
      toast({ variant: "error", message: e?.message || "點播失敗" });
    }
  }, [confirmedNick, roomId, vocalMode, performanceMode, participants, duetPartnerId, dedicateTo, toast]);

  const addSong = useCallback(async (s: SearchResult) => {
    if (!confirmedNick || addingId) return;
    setAddingId(s.video_id);
    try {
      await addByVideo(s);
    } catch (e: any) {
      toast({ variant: "error", message: e.message || "點播失敗" });
    } finally {
      setTimeout(() => setAddingId(null), 200);
    }
  }, [confirmedNick, addingId, addByVideo, toast]);

  // Favorites: surfaced in the Discover panel + a ♥ toggle on search results.
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!confirmedNick) return;
    const uid = getIdentity()?.user_id;
    if (!uid) return;
    api.getFavorites(uid)
      .then((rows) => setFavorites(new Set(rows.map((r) => r.video_id))))
      .catch(() => {});
  }, [confirmedNick]);

  const toggleFavorite = useCallback((video_id: string, title: string) => {
    const uid = getIdentity()?.user_id;
    if (!uid) return;
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(video_id)) {
        next.delete(video_id);
        void api.removeFavorite(uid, video_id).catch(() => {});
      } else {
        next.add(video_id);
        void api.addFavorite(uid, video_id, title).catch(() => {});
        toast({ variant: "success", message: `♥ 已收藏 - ${title}` });
      }
      return next;
    });
  }, [toast]);

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

  const sendChat = useCallback((kind: "text" | "emoji" = "text", message?: string) => {
    const m = (message ?? chatText).trim();
    if (!m) return;
    wsRef.current?.send("chat.send", {
      user_id: getIdentity()?.user_id,
      nickname: confirmedNick,
      kind,
      message: m,
    });
    if (kind === "text") setChatText("");
  }, [chatText, confirmedNick]);

  const myCount = useMemo(
    () => queue.filter((x) => x.status !== "done" && isMine(x)).length,
    [queue, isMine],
  );

  const myQueueItems = useMemo(() => queue.filter(x => isMine(x)), [queue, isMine]);
  const myNext = useMemo(() => {
    const queuedMine = queue
      .filter((q) => isMine(q) && q.status === "queued")
      .sort((a, b) => a.position - b.position);
    const next = queuedMine[0];
    if (!next) return null;
    const aheadSec = queue
      .filter((q) => q.status !== "done" && q.position < next.position)
      .reduce((acc, q) => acc + (q.duration_sec || 0), 0);
    return { position: next.position, etaMin: Math.max(1, Math.round(aheadSec / 60)) };
  }, [queue, isMine]);

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
  }, [isSinger]);

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
      const next = Math.max(-2, Math.min(2, Math.round((v + delta) * 10) / 10));
      try { window.localStorage.setItem(`ktv-lyric-offset-${playing.video_id}`, String(next)); } catch {}
      wsRef.current?.send("lyric.nudge", { item_id: playing.id, delta_sec: delta });
      void api.setLyricOffset(playing.video_id, next).catch(() => {});
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
        const uid = getIdentity()?.user_id;
        wsRef.current?.send("skip_current", { user_id: uid });
      } catch (e: any) {
        toast({ variant: "error", message: e.message || "跳過失敗" });
      }
    }
  }, [playing, toast]);

  const insertTop = useCallback((itemId: number) => {
    wsRef.current?.send("insert_top", { item_id: itemId, user_id: getIdentity()?.user_id });
  }, []);

  const voteSkip = useCallback(() => {
    wsRef.current?.send("skip_current", { user_id: getIdentity()?.user_id });
  }, []);


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
            {myNext && (
              <div className="text-[11px] text-white/55">
                下一首第 {myNext.position} 位，約 {myNext.etaMin} 分鐘
              </div>
            )}
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
                    type="button"
                    className={cn("flex-1 py-2 text-sm font-bold rounded-lg transition-colors", playing.vocal_mode === "original" ? "bg-ktv-gold text-ktv-bg shadow-md" : "text-white/70")}
                    onClick={() => toggleSingerVocalMode("original")}
                  >
                    🎵 原唱
                  </button>
                  <button
                    type="button"
                    className={cn("flex-1 py-2 text-sm font-bold rounded-lg transition-colors", playing.vocal_mode === "instrumental" ? "bg-ktv-mic text-ktv-bg shadow-md" : "text-white/70")}
                    onClick={() => toggleSingerVocalMode("instrumental")}
                  >
                    🎤 伴奏
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <label htmlFor="performance-mode" className="text-xs text-white/50">模式</label>
                  <select
                    id="performance-mode"
                    className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs"
                    value={performanceMode}
                    onChange={(e) => setPerformanceMode(e.target.value as "solo" | "duet" | "chorus")}
                  >
                    <option value="solo">獨唱</option>
                    <option value="duet">對唱</option>
                    <option value="chorus">合唱</option>
                  </select>
                </div>

                <Input
                  value={dedicateTo}
                  onChange={(e) => setDedicateTo(e.target.value)}
                  placeholder="點播給誰（可選）"
                  className="h-9 bg-white/5 border-white/10"
                />

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
                <input
                  type="range"
                  min={-2}
                  max={2}
                  step={0.1}
                  value={localOffset}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    const delta = next - localOffset;
                    if (Math.abs(delta) > 0.0001) nudgeLyric(delta);
                  }}
                />

                {/* Skip */}
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="danger" className="w-full mt-1" onClick={skipMySong}>
                    房主切歌
                  </Button>
                  <Button variant="ghost" className="w-full mt-1" onClick={voteSkip}>
                    投票切歌
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  className="w-full"
                  onClick={() => {
                    const corrected = prompt("歌詞校正：請輸入正確歌詞");
                    if (!corrected || !playing) return;
                    api.reportLyricsCorrection(playing.video_id, {
                      corrected_text: corrected,
                      user_id: getIdentity()?.user_id,
                    }).then(() => toast({ variant: "success", message: "已送出歌詞校正" })).catch(() => {});
                  }}
                >
                  回報歌詞錯誤
                </Button>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="ghost" className="w-full" onClick={() => api.setSkipMode(roomId, "owner").catch(() => {})}>
                    房主模式
                  </Button>
                  <Button variant="ghost" className="w-full" onClick={() => api.setSkipMode(roomId, "vote").catch(() => {})}>
                    投票模式
                  </Button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Button variant="ghost" className="w-full" onClick={() => api.setTheme(roomId, "cashbox-green").catch(() => {})}>綠</Button>
                  <Button variant="ghost" className="w-full" onClick={() => api.setTheme(roomId, "star-purple").catch(() => {})}>紫</Button>
                  <Button variant="ghost" className="w-full" onClick={() => api.setTheme(roomId, "holiday-blue").catch(() => {})}>藍</Button>
                </div>
                <Button
                  variant="gold"
                  className="w-full"
                  onClick={() => api.extendRoom(roomId, 30).then(() => toast({ variant: "success", message: "已續鐘 30 分" })).catch(() => {})}
                >
                  ⏰ 續鐘 +30 分
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
              type="button"
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
              type="button"
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

        {!isSinger && (
          <div className="flex flex-col gap-2">
            <div className="flex bg-white/5 p-1 rounded-xl border border-white/5">
              {([["solo", "獨唱"], ["duet", "對唱"], ["chorus", "合唱"]] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={cn(
                    "flex-1 py-2 text-sm font-bold rounded-lg transition-colors",
                    performanceMode === mode ? "bg-ktv-accent text-white shadow-md" : "text-white/60",
                  )}
                  onClick={() => setPerformanceMode(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
            {performanceMode === "duet" && (
              <select
                aria-label="對唱夥伴"
                className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
                value={duetPartnerId}
                onChange={(e) => setDuetPartnerId(e.target.value)}
              >
                <option value="">選擇對唱夥伴…</option>
                {participants
                  .filter((p) => p.user_id && p.user_id !== getIdentity()?.user_id)
                  .map((p) => (
                    <option key={p.user_id} value={p.user_id}>
                      {p.nickname || p.user_id}
                    </option>
                  ))}
              </select>
            )}
          </div>
        )}
      </section>

      {/* Discover: favorites / hot charts / recommendations */}
      <DiscoverPanel
        userId={getIdentity()?.user_id}
        playingVideoId={playing?.video_id}
        onAdd={addByVideo}
        favorites={favorites}
        onToggleFavorite={toggleFavorite}
      />

      {/* Search results */}
      {hasSearched && !searching && results.length === 0 && (
        <div className="px-4 mt-8">
          <div className="py-10 flex flex-col items-center justify-center bg-white/5 rounded-2xl border border-white/5 border-dashed text-center">
            <div className="text-4xl mb-2 opacity-50">🔍</div>
            <div className="text-white/60 font-medium">找不到相關歌曲</div>
            <div className="text-white/40 text-xs mt-1">換個關鍵字，或試試上方探索榜單</div>
          </div>
        </div>
      )}
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
                    <IconButton
                      aria-label="收藏"
                      variant="ghost"
                      className="shrink-0 w-9 h-9"
                      icon={
                        <span className={cn("text-base", favorites.has(r.video_id) ? "text-ktv-accent" : "text-white/30")}>
                          {favorites.has(r.video_id) ? "♥" : "♡"}
                        </span>
                      }
                      onClick={() => toggleFavorite(r.video_id, r.title)}
                    />
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
                        <div className="flex items-center gap-1">
                          <IconButton
                            icon={<span className="text-sm">↑</span>}
                            aria-label="插播下一首"
                            variant="ghost"
                            className="text-white/30 hover:text-ktv-gold hover:bg-ktv-gold/10 shrink-0"
                            onClick={() => insertTop(it.id)}
                          />
                          <IconButton
                            icon={<span className="text-sm">✕</span>}
                            aria-label="移除點播"
                            variant="ghost"
                            className="text-white/30 hover:text-ktv-accent hover:bg-ktv-accent/10 shrink-0"
                            onClick={() => removeSong(it)}
                          />
                        </div>
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
        <div className="max-w-sm mx-auto px-4 mb-2 flex gap-2">
          <Input
            value={chatText}
            onChange={(e) => setChatText(e.target.value)}
            placeholder="發送彈幕訊息..."
            className="h-10 bg-white/5 border-white/10"
          />
          <Button variant="ghost" onClick={() => sendChat("text")}>送出</Button>
          <Button variant="ghost" onClick={() => sendChat("emoji", "🔥")}>🔥</Button>
        </div>
        <div className="flex justify-around max-w-sm mx-auto px-4 relative pb-3">
          <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-2 bg-ktv-panel text-[10px] text-white/40 uppercase tracking-widest font-bold rounded-full">氣氛特效</div>
          
          <button
            type="button"
            onClick={() => sendAtmosphere("clap")} 
            className="w-14 h-14 rounded-full bg-white/5 hover:bg-white/10 active:scale-90 active:bg-white/20 transition-all flex items-center justify-center text-2xl shadow-lg border border-white/5 group"
            aria-label="拍手"
          >
            <span className="group-hover:-translate-y-1 transition-transform">👏</span>
          </button>
          <button
            type="button"
            onClick={() => sendAtmosphere("confetti")} 
            className="w-14 h-14 rounded-full bg-white/5 hover:bg-white/10 active:scale-90 active:bg-white/20 transition-all flex items-center justify-center text-2xl shadow-lg border border-white/5 group"
            aria-label="彩帶"
          >
            <span className="group-hover:-translate-y-1 transition-transform">🎊</span>
          </button>
          <button
            type="button"
            onClick={() => sendAtmosphere("fireworks")} 
            className="w-14 h-14 rounded-full bg-white/5 hover:bg-white/10 active:scale-90 active:bg-white/20 transition-all flex items-center justify-center text-2xl shadow-lg border border-white/5 group"
            aria-label="煙火"
          >
            <span className="group-hover:-translate-y-1 transition-transform">🎆</span>
          </button>
          <button
            type="button"
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
