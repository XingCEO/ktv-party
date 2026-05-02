"use client";

import React, { useEffect, useState } from "react";
import { motion, useAnimation } from "framer-motion";
import confetti from "canvas-confetti";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

const WITTY_REACTIONS = [
  "音準很穩",
  "節奏抓得好",
  "副歌爆發力十足",
  "氣場全開",
  "現場感滿分",
  "感情豐富",
  "高音完美",
  "低音沉穩",
  "轉音流暢",
  "技巧純熟",
  "感染力強",
  "開口跪",
  "靈魂歌手",
  "神仙嗓音",
  "耳朵懷孕"
];

function seedScore(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h << 5) - h + seed.charCodeAt(i);
  }
  return 70 + (Math.abs(h) % 30); // 70-99
}

function getReactions(seed: string): string[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h << 5) - h + seed.charCodeAt(i);
  }
  h = Math.abs(h);
  
  const selected: string[] = [];
  const pool = [...WITTY_REACTIONS];
  
  for (let i = 0; i < 3; i++) {
    const idx = (h + i * 17) % pool.length;
    selected.push(pool[idx]);
    pool.splice(idx, 1);
  }
  
  return selected;
}

export type ScoreScreenProps = {
  visible: boolean;
  songTitle: string;
  singerName: string;
  seed?: string;
  onDismiss: () => void;
};

export function ScoreScreen({
  visible,
  songTitle,
  singerName,
  seed = "",
  onDismiss,
}: ScoreScreenProps) {
  const [displayScore, setDisplayScore] = useState(0);
  const controls = useAnimation();

  useEffect(() => {
    if (!visible) {
      setDisplayScore(0);
      return;
    }

    const timer = setTimeout(() => {
      onDismiss();
    }, 5000);

    // Fire confetti on first appearance
    confetti({
      particleCount: 100,
      spread: 70,
      origin: { y: 0.6 },
      colors: ["#ff4d8d", "#ffd166", "#06d6a0", "#ffffff"],
    });

    const targetScore = seedScore(seed);
    
    // Animate number
    controls.start({
      opacity: 1,
      transition: { duration: 1.5, ease: "easeOut" }
    });

    let startTime: number;
    let animationFrame: number;
    
    const animateScore = (timestamp: number) => {
      if (!startTime) startTime = timestamp;
      const progress = Math.min((timestamp - startTime) / 1500, 1);
      // easeOutExpo
      const easeProgress = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      setDisplayScore(Math.round(targetScore * easeProgress));
      
      if (progress < 1) {
        animationFrame = requestAnimationFrame(animateScore);
      }
    };
    
    animationFrame = requestAnimationFrame(animateScore);

    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(animationFrame);
    };
  }, [visible, seed, onDismiss, controls]);

  if (!visible) return null;

  const targetScore = seedScore(seed);
  const reactions = getReactions(seed);

  let emoji = "🎵 加油！";
  let emojiColor = "text-white/70";
  if (targetScore >= 95) {
    emoji = "🔥 完美！";
    emojiColor = "text-ktv-gold";
  } else if (targetScore >= 85) {
    emoji = "⭐ 太棒了！";
    emojiColor = "text-ktv-gold";
  } else if (targetScore >= 75) {
    emoji = "👍 不錯喔！";
    emojiColor = "text-ktv-mic";
  } else if (targetScore >= 65) {
    emoji = "😊 還可以";
    emojiColor = "text-white";
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ktv-bg/80 backdrop-blur-md">
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", damping: 20, stiffness: 300 }}
        className="w-full max-w-md p-4"
      >
        <Card glow={true} className="border-ktv-gold/40 bg-black/60 shadow-[0_0_60px_rgba(255,209,102,0.15)] text-center">
          <CardBody className="flex flex-col items-center p-10 gap-6">
            <h2 className="text-3xl font-black text-ktv-gold drop-shadow-[0_0_10px_rgba(255,209,102,0.6)]">
              演唱結束！
            </h2>
            
            <div className="space-y-1">
              <p className="text-2xl font-bold text-white truncate max-w-[300px]">
                {songTitle}
              </p>
              <p className="text-lg text-white/70 truncate max-w-[300px]">
                @{singerName}
              </p>
            </div>

            <div className="relative py-4">
              <span className="text-8xl font-black text-white drop-shadow-[0_0_20px_rgba(255,255,255,0.8)] tracking-tighter">
                {displayScore}
              </span>
            </div>

            <div className={`text-2xl font-bold ${emojiColor} drop-shadow-md`}>
              {emoji}
            </div>

            <div className="flex flex-wrap justify-center gap-2 mt-2">
              {reactions.map((r, i) => (
                <span key={i} className="px-3 py-1 text-sm rounded-full bg-white/10 text-white/90 border border-white/20">
                  {r}
                </span>
              ))}
            </div>

            <Button 
              onClick={onDismiss}
              className="mt-6 w-full max-w-[200px] text-lg font-bold bg-ktv-gold hover:bg-ktv-gold/90 text-black border-none"
            >
              繼續
            </Button>
          </CardBody>
        </Card>
      </motion.div>
    </div>
  );
}
