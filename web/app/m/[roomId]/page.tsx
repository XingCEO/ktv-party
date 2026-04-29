"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { api, fmtDuration, type QueueItem, type SearchResult } from "@/lib/api";
import { ensureIdentity, getIdentity } from "@/lib/identity";
import { RoomSocket } from "@/lib/ws";
import { cn } from "@/lib/cn";

export default function PhonePage() {
  const params = useParams<{ roomId: string }>();
  const roomId = params.roomId;
  const [nickname, setNickname] = useState("");
  const [confirmedNick, setConfirmedNick] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [vocalMode, setVocalMode] = useState<"original" | "instrumental">("original");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const wsRef = useRef<RoomSocket | null>(null);

  // Restore nickname
  useEffect(() => {
    const id = getIdentity();
    if (id) {
      setNickname(id.nickname);
      setConfirmedNick(id.nickname);
    }
  }, []);

  // Load + subscribe
  useEffect(() => {
    if (!confirmedNick) return;
    api.getQueue(roomId).then(setQueue).catch((e) => setError(e.message));
    const ws = new RoomSocket(roomId);
    wsRef.current = ws;
    const off = ws.on((m) => {
      if (m.event === "room.snapshot") setQueue(m.data.queue || []);
      if (m.event === "queue.added" || m.event === "queue.removed" || m.event === "queue.reordered" || m.event === "playback.advanced") {
        setQueue(m.data.queue || []);
      }
      if (m.event === "vocal_removal.ready") {
        setToast(`✨ 消音完成: ${m.data.video_id}`);
        setTimeout(() => setToast(null), 3000);
      }
    });
    ws.connect();
    return () => {
      off();
      ws.close();
    };
  }, [roomId, confirmedNick]);

  function joinRoom() {
    const n = nickname.trim();
    if (!n) return;
    ensureIdentity(n);
    setConfirmedNick(n);
  }

  async function doSearch() {
    if (!q.trim()) return;
    setSearching(true);
    setError(null);
    try {
      setResults(await api.search(q.trim(), 12));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSearching(false);
    }
  }

  async function addSong(s: SearchResult) {
    if (!confirmedNick) return;
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
      setToast(`已加入點播: ${s.title}`);
      setTimeout(() => setToast(null), 2000);
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function removeSong(item: QueueItem) {
    if (item.nickname !== confirmedNick) return;
    if (!confirm(`移除 "${item.title}"?`)) return;
    try {
      await api.removeQueueItem(roomId, item.id);
    } catch (e: any) {
      setError(e.message);
    }
  }

  function sendAtmosphere(kind: "confetti" | "fireworks" | "clap" | "birthday") {
    wsRef.current?.send(`atmosphere.${kind}`, { from: confirmedNick, ts: Date.now() });
  }

  const myCount = useMemo(
    () => queue.filter((x) => x.nickname === confirmedNick && x.status !== "done").length,
    [queue, confirmedNick],
  );

  if (!confirmedNick) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div className="panel p-6 w-full max-w-sm">
          <h1 className="text-2xl font-bold mb-2 text-ktv-gold">加入包廂</h1>
          <p className="text-sm text-white/60 mb-4">房間 {roomId}</p>
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="你的暱稱"
            className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 mb-3 text-lg"
            maxLength={20}
            onKeyDown={(e) => e.key === "Enter" && joinRoom()}
          />
          <button onClick={joinRoom} className="btn-primary w-full text-lg py-3">
            進入
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen pb-24">
      {/* Header */}
      <header className="sticky top-0 z-20 backdrop-blur bg-ktv-bg/85 border-b border-white/5">
        <div className="px-4 py-3 flex items-center justify-between">
          <div>
            <div className="text-xs text-white/50">包廂 {roomId}</div>
            <div className="font-bold">{confirmedNick} · 我的點播 {myCount}</div>
          </div>
          <button
            onClick={() => {
              localStorage.removeItem("ktv-identity-v1");
              setConfirmedNick(null);
            }}
            className="btn-ghost text-sm"
          >
            切換暱稱
          </button>
        </div>
      </header>

      {/* Search */}
      <section className="px-4 pt-4">
        <div className="flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜尋歌曲 / 歌手"
            className="flex-1 px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-base"
            onKeyDown={(e) => e.key === "Enter" && doSearch()}
          />
          <button onClick={doSearch} className="btn-primary px-5" disabled={searching}>
            {searching ? "..." : "搜尋"}
          </button>
        </div>
        <div className="flex items-center gap-2 mt-3 text-sm">
          <span className="text-white/60">人聲模式</span>
          <button
            className={cn(
              "pill border",
              vocalMode === "original" ? "bg-ktv-gold/90 text-black border-transparent" : "border-white/15 text-white/70",
            )}
            onClick={() => setVocalMode("original")}
          >
            原唱
          </button>
          <button
            className={cn(
              "pill border",
              vocalMode === "instrumental" ? "bg-ktv-mic text-black border-transparent" : "border-white/15 text-white/70",
            )}
            onClick={() => setVocalMode("instrumental")}
          >
            消音 (伴奏)
          </button>
        </div>
      </section>

      {/* Search results */}
      {results.length > 0 && (
        <section className="px-4 mt-4">
          <h2 className="text-sm font-bold text-white/70 mb-2">搜尋結果</h2>
          <ul className="space-y-2">
            {results.map((r) => (
              <li key={r.video_id} className="panel p-3 flex gap-3 items-center">
                {r.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.thumbnail_url} alt="" className="w-16 h-16 rounded-lg object-cover" />
                ) : (
                  <div className="w-16 h-16 bg-white/10 rounded-lg" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">{r.title}</div>
                  <div className="text-xs text-white/60 truncate">
                    {r.channel || "—"} · {fmtDuration(r.duration_sec)}
                  </div>
                </div>
                <button onClick={() => addSong(r)} className="btn-primary px-3 py-2 text-sm">
                  點播
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Queue */}
      <section className="px-4 mt-6">
        <h2 className="text-sm font-bold text-white/70 mb-2">點播清單</h2>
        {queue.length === 0 ? (
          <p className="text-white/50 text-sm">尚未有人點歌</p>
        ) : (
          <ul className="space-y-2">
            {queue.map((it) => (
              <li
                key={it.id}
                className={cn(
                  "panel p-3 flex items-center gap-3",
                  it.status === "playing" && "ring-2 ring-ktv-mic",
                )}
              >
                <div className="w-8 text-center text-xl font-bold text-white/40">
                  {it.status === "playing" ? "▶" : it.position}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">{it.title}</div>
                  <div className="text-xs text-white/60 truncate">
                    @{it.nickname} · {fmtDuration(it.duration_sec)}
                    {it.vocal_mode === "instrumental" && (
                      <span className="ml-2 pill bg-ktv-mic/20 text-ktv-mic">消音</span>
                    )}
                  </div>
                </div>
                {it.nickname === confirmedNick && it.status !== "playing" && (
                  <button onClick={() => removeSong(it)} className="text-white/50 hover:text-ktv-accent text-xl px-2">
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Atmosphere bar */}
      <nav className="fixed bottom-0 inset-x-0 z-30 bg-ktv-panel/95 backdrop-blur border-t border-white/10 px-4 py-2">
        <div className="flex justify-around">
          <button onClick={() => sendAtmosphere("clap")} className="btn-ghost text-xl" aria-label="拍手">
            👏
          </button>
          <button onClick={() => sendAtmosphere("confetti")} className="btn-ghost text-xl" aria-label="彩帶">
            🎊
          </button>
          <button onClick={() => sendAtmosphere("fireworks")} className="btn-ghost text-xl" aria-label="煙火">
            🎆
          </button>
          <button onClick={() => sendAtmosphere("birthday")} className="btn-ghost text-xl" aria-label="生日">
            🎂
          </button>
        </div>
      </nav>

      {error && (
        <div className="fixed top-20 inset-x-4 panel p-3 text-ktv-accent z-40 text-sm">
          ⚠ {error}
          <button className="float-right text-white/40" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}
      {toast && (
        <div className="fixed bottom-24 inset-x-6 panel p-3 text-center text-ktv-gold z-40">
          {toast}
        </div>
      )}
    </main>
  );
}
