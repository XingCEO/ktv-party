"use client";

import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { api, fmtDuration } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Spinner";
import { IconButton } from "@/components/ui/IconButton";

export type DiscoverItem = {
  video_id: string;
  title: string;
  channel?: string | null;
  duration_sec?: number | null;
  thumbnail_url?: string | null;
  subtitle?: string;
};

type Tab = "fav" | "hot" | "rank" | "rec";

const TABS: Array<{ key: Tab; label: string; icon: string }> = [
  { key: "fav", label: "最愛", icon: "❤️" },
  { key: "hot", label: "本廂熱門", icon: "🔥" },
  { key: "rank", label: "排行榜", icon: "🏆" },
  { key: "rec", label: "推薦", icon: "✨" },
];

const EMPTY_HINT: Record<Tab, string> = {
  fav: "還沒有收藏的歌，點搜尋結果旁的 ♥ 加入最愛",
  hot: "尚無熱門資料，多唱幾首就會出現排行",
  rank: "排行榜載入中或暫無資料",
  rec: "開始播放一首歌後即可獲得推薦",
};

export function DiscoverPanel({
  userId,
  playingVideoId,
  onAdd,
  favorites,
  onToggleFavorite,
}: {
  userId?: string;
  playingVideoId?: string | null;
  onAdd: (it: DiscoverItem) => void | Promise<void>;
  favorites: Set<string>;
  onToggleFavorite: (video_id: string, title: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("hot");
  const [items, setItems] = useState<DiscoverItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);

  const load = useCallback(
    async (t: Tab) => {
      setLoading(true);
      try {
        if (t === "fav") {
          if (!userId) {
            setItems([]);
            return;
          }
          const rows = await api.getFavorites(userId);
          setItems(rows.map((r) => ({ video_id: r.video_id, title: r.title })));
        } else if (t === "hot") {
          const rows = await api.getLocalCharts("week");
          setItems(
            rows.map((r) => ({
              video_id: r.video_id,
              title: r.title,
              subtitle: `${r.play_count} 次點播`,
            })),
          );
        } else if (t === "rank") {
          const rows = await api.getWeeklyHot(30);
          setItems(
            rows.map((r) => ({
              // Placeholder id (apple:idx:title) — parent resolves to a real
              // YouTube hit via channel(artist)+title on add.
              video_id: r.video_id,
              title: r.title,
              channel: r.artist,
              subtitle: r.artist ? `${r.rank_no}. ${r.artist}` : `第 ${r.rank_no} 名`,
            })),
          );
        } else {
          if (!playingVideoId) {
            setItems([]);
            return;
          }
          const rows = await api.getRecommend(playingVideoId);
          setItems(
            rows.map((r) => ({
              video_id: r.video_id,
              title: r.title,
              channel: r.channel,
              duration_sec: r.duration_sec,
              thumbnail_url: r.thumbnail_url,
            })),
          );
        }
      } catch {
        setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [userId, playingVideoId],
  );

  useEffect(() => {
    if (open) void load(tab);
  }, [open, tab, load]);

  const handleAdd = useCallback(
    async (it: DiscoverItem) => {
      if (addingId) return;
      setAddingId(it.video_id);
      try {
        await onAdd(it);
      } finally {
        setTimeout(() => setAddingId(null), 200);
      }
    },
    [addingId, onAdd],
  );

  return (
    <section className="px-4 mt-8">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-sm font-bold text-white/50 uppercase tracking-wider mb-3 group"
      >
        <span className="flex items-center gap-2">
          <span className="w-4 h-[1px] bg-white/20" />
          探索 · 點歌靈感
        </span>
        <span className={cn("transition-transform text-white/40", open ? "rotate-180" : "")}>▾</span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="flex bg-white/5 p-1 rounded-xl border border-white/5 mb-3">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={cn(
                    "flex-1 py-2 text-xs font-bold rounded-lg transition-colors",
                    tab === t.key ? "bg-ktv-accent text-white shadow-md" : "text-white/60",
                  )}
                >
                  {t.icon} {t.label}
                </button>
              ))}
            </div>

            {loading ? (
              <div className="py-8 flex justify-center">
                <Spinner size="sm" />
              </div>
            ) : items.length === 0 ? (
              <div className="py-8 text-center text-xs text-white/40 bg-white/5 rounded-xl border border-white/5 border-dashed px-4">
                {EMPTY_HINT[tab]}
              </div>
            ) : (
              <ul className="space-y-2">
                {items.map((it, i) => (
                  <li key={`${it.video_id}-${i}`}>
                    <Card className="bg-panel border-white/5 p-2.5 flex items-center gap-2">
                      <div className="w-7 text-center text-sm font-bold text-white/25 shrink-0">
                        {tab === "hot" ? i + 1 : tab === "rec" ? "✨" : "♥"}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-bold truncate text-sm leading-snug">{it.title}</div>
                        <div className="text-[11px] text-white/45 truncate">
                          {it.subtitle || it.channel || (it.duration_sec ? fmtDuration(it.duration_sec) : "")}
                        </div>
                      </div>
                      {userId && (
                        <IconButton
                          aria-label="收藏"
                          variant="ghost"
                          className="shrink-0 w-8 h-8"
                          icon={
                            <span className={cn("text-sm", favorites.has(it.video_id) ? "text-ktv-accent" : "text-white/30")}>
                              {favorites.has(it.video_id) ? "♥" : "♡"}
                            </span>
                          }
                          onClick={() => onToggleFavorite(it.video_id, it.title)}
                        />
                      )}
                      <Button
                        size="sm"
                        variant="primary"
                        className="shrink-0"
                        loading={addingId === it.video_id}
                        onClick={() => handleAdd(it)}
                      >
                        點播
                      </Button>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
