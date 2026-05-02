"use client";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

export type PresenceEvent = { kind: "joined" | "left"; nickname: string; ts: number } | null;

export default function PresenceToast({ trigger }: { trigger: PresenceEvent }) {
  const [items, setItems] = useState<Array<{ id: number; kind: "joined" | "left"; nickname: string }>>([]);
  useEffect(() => {
    if (!trigger) return;
    const id = trigger.ts;
    setItems(prev => [...prev, { id, kind: trigger.kind, nickname: trigger.nickname }]);
    const t = setTimeout(() => setItems(prev => prev.filter(i => i.id !== id)), 3000);
    return () => clearTimeout(t);
  }, [trigger]);

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-40 pointer-events-none flex flex-col items-center gap-2">
      <AnimatePresence>
        {items.map((it) => (
          <motion.div
            key={it.id}
            initial={{ opacity: 0, y: -20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.9 }}
            className="bg-ktv-panel/90 backdrop-blur border border-white/10 rounded-full px-4 py-2 shadow-lg text-sm"
          >
            <span className="text-white/60">{it.kind === "joined" ? "👋" : "👋"}</span>{" "}
            <span className="font-bold text-ktv-gold">{it.nickname}</span>{" "}
            <span className="text-white/60">{it.kind === "joined" ? "加入了" : "離開了"}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
