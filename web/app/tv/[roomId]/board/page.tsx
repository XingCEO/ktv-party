"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { api, type QueueItem } from "@/lib/api";

export default function TvBoardPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [history, setHistory] = useState<Array<{ video_id: string; title: string; nickname: string; created_at: number }>>([]);

  useEffect(() => {
    api.getQueue(roomId).then(setQueue).catch(() => {});
    api.getLocalCharts?.("week").then((rows: any) => setHistory(rows || [])).catch(() => {});
    const t = setInterval(() => {
      api.getQueue(roomId).then(setQueue).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [roomId]);

  const queued = useMemo(() => queue.filter((q) => q.status === "queued"), [queue]);
  const playing = useMemo(() => queue.find((q) => q.status === "playing") || null, [queue]);

  return (
    <main className="min-h-screen bg-ktv-bg text-white p-6 grid grid-cols-12 gap-4">
      <section className="col-span-7 panel p-4">
        <h1 className="text-2xl font-bold mb-3">副螢幕：佇列與歷史</h1>
        <div className="mb-3 text-sm text-white/70">房間 {roomId}</div>
        {playing && <div className="mb-4 p-3 rounded-xl bg-ktv-mic/20">正在播放：{playing.title} · @{playing.nickname}</div>}
        <ul className="space-y-2">
          {queued.map((q) => (
            <li key={q.id} className="flex justify-between panel px-3 py-2">
              <span>{q.position}. {q.title}</span>
              <span className="text-white/60">@{q.nickname}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="col-span-5 panel p-4">
        <h2 className="text-xl font-bold mb-3">本地熱門/歷史</h2>
        <ul className="space-y-2 text-sm">
          {history.slice(0, 20).map((h, idx) => (
            <li key={`${h.video_id}-${h.created_at || idx}`} className="flex justify-between border-b border-white/10 py-1">
              <span className="truncate pr-2">{h.title}</span>
              <span className="text-white/60">#{idx + 1}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
