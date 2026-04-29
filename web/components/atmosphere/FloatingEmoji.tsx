"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";

type Floater = { id: number; emoji: string; x: number };

export default function FloatingEmoji({ trigger }: { trigger: { kind: string; ts: number } | null }) {
  const [items, setItems] = useState<Floater[]>([]);

  useEffect(() => {
    if (!trigger) return;
    const emojiMap: Record<string, string> = {
      "atmosphere.clap": "👏",
      "atmosphere.confetti": "🎊",
      "atmosphere.fireworks": "🎆",
      "atmosphere.birthday": "🎂",
    };
    const e = emojiMap[trigger.kind] || "✨";
    const burst = Array.from({ length: 6 }, (_, i) => ({
      id: trigger.ts + i,
      emoji: e,
      x: Math.random() * 90 + 5,
    }));
    setItems((prev) => [...prev, ...burst]);
    const t = setTimeout(() => {
      setItems((prev) => prev.filter((it) => !burst.find((b) => b.id === it.id)));
    }, 2200);
    return () => clearTimeout(t);
  }, [trigger]);

  return (
    <div className="pointer-events-none fixed inset-0 z-30 overflow-hidden">
      <AnimatePresence>
        {items.map((it) => (
          <motion.div
            key={it.id}
            initial={{ y: "100vh", opacity: 0, scale: 0.5 }}
            animate={{ y: "-10vh", opacity: 1, scale: 1.4 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 2, ease: "easeOut" }}
            style={{ left: `${it.x}%` }}
            className="absolute text-6xl"
          >
            {it.emoji}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
