"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { api, type QueueItem } from "@/lib/api";
import { RoomSocket } from "@/lib/ws";

type LocalChart = { video_id: string; title: string; play_count: number };
type WeeklyHotItem = {
  source: string;
  chart_key: string;
  video_id: string;
  title: string;
  artist: string | null;
  rank_no: number;
};

export default function TvBoardPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [localCharts, setLocalCharts] = useState<LocalChart[]>([]);
  const [weeklyHot, setWeeklyHot] = useState<WeeklyHotItem[]>([]);

  // WebSocket live queue
  useEffect(() => {
    api.getQueue(roomId).then(setQueue).catch(() => {});

    const ws = new RoomSocket(roomId);
    const off = ws.on((m) => {
      if (m.event === "room.snapshot") {
        setQueue(m.data.queue || []);
        return;
      }
      if (
        m.event === "queue.added" ||
        m.event === "queue.removed" ||
        m.event === "queue.reordered" ||
        m.event === "queue.vocal_mode.updated" ||
        m.event === "playback.advanced" ||
        m.event === "insert_top"
      ) {
        setQueue(m.data.queue || []);
      }
    });
    ws.connect();
    return () => {
      off();
      ws.close();
    };
  }, [roomId]);

  // Charts: initial fetch + refresh every 60s
  useEffect(() => {
    function fetchCharts() {
      api.getLocalCharts("week").then(setLocalCharts).catch(() => {});
      api.getWeeklyHot(20).then(setWeeklyHot).catch(() => {});
    }
    fetchCharts();
    const t = setInterval(fetchCharts, 60_000);
    return () => clearInterval(t);
  }, []);

  const playing = useMemo(() => queue.find((q) => q.status === "playing") ?? null, [queue]);
  const queued = useMemo(() => queue.filter((q) => q.status === "queued"), [queue]);

  return (
    <main className="min-h-screen bg-ktv-bg text-white p-6 grid grid-cols-12 gap-4">
      {/* ── Left: live queue ── */}
      <section className="col-span-7 flex flex-col gap-4">
        <div className="panel p-6">
          <h1 className="text-3xl font-bold mb-6 tracking-wide">點播佇列</h1>

          {/* Currently playing */}
          {playing ? (
            <div className="mb-6 p-4 rounded-2xl bg-ktv-mic/20 border border-ktv-mic/40 flex items-center gap-4">
              <span className="text-ktv-mic text-2xl">▶</span>
              <div className="min-w-0">
                <p className="text-xl font-semibold truncate">{playing.title}</p>
                <p className="text-white/60 text-lg mt-0.5">@{playing.nickname}</p>
              </div>
            </div>
          ) : null}

          {/* Queued items */}
          {queued.length === 0 && !playing ? (
            <p className="text-white/40 text-xl text-center py-10">尚未有人點歌</p>
          ) : queued.length === 0 ? (
            <p className="text-white/40 text-lg text-center py-6">佇列已空</p>
          ) : (
            <ul className="space-y-3">
              {queued.map((q) => (
                <li
                  key={q.id}
                  className="panel px-4 py-3 flex items-center gap-4"
                >
                  <span className="text-white/40 text-xl w-8 text-right shrink-0">
                    {q.position}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-lg font-medium truncate">{q.title}</p>
                  </div>
                  <span className="text-white/50 text-base shrink-0">@{q.nickname}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ── Right: charts ── */}
      <aside className="col-span-5 flex flex-col gap-4">
        {/* Local hot */}
        <div className="panel p-5 flex-1">
          <h2 className="text-2xl font-bold mb-4">🔥 本週熱門點播</h2>
          {localCharts.length === 0 ? (
            <p className="text-white/40 text-base py-4 text-center">暫無資料</p>
          ) : (
            <ul className="space-y-2">
              {localCharts.slice(0, 20).map((item, idx) => (
                <li
                  key={item.video_id}
                  className="flex items-center gap-3 border-b border-white/10 py-2"
                >
                  <span className="text-white/40 text-base w-6 text-right shrink-0">
                    {idx + 1}
                  </span>
                  <span className="flex-1 truncate text-base">{item.title}</span>
                  <span className="text-white/50 text-sm shrink-0">{item.play_count} 次</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Weekly hot external */}
        <div className="panel p-5 flex-1">
          <h2 className="text-2xl font-bold mb-1">🏆 排行榜 · iTunes 台灣</h2>
          <p className="text-xs text-white/30 mb-4">外部榜單僅供參考</p>
          {weeklyHot.length === 0 ? (
            <p className="text-white/40 text-base py-4 text-center">暫無資料</p>
          ) : (
            <ul className="space-y-2">
              {weeklyHot.map((item) => (
                <li
                  key={`${item.chart_key}-${item.rank_no}`}
                  className="flex items-center gap-3 border-b border-white/10 py-2"
                >
                  <span className="text-white/40 text-base w-6 text-right shrink-0">
                    {item.rank_no}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-base">{item.title}</p>
                    {item.artist && (
                      <p className="truncate text-sm text-white/60">{item.artist}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </main>
  );
}
