"use client";
import { useEffect } from "react";
import confetti from "canvas-confetti";

type Kind = "confetti" | "fireworks" | "clap" | "birthday";

export default function Atmosphere({ trigger }: { trigger: { kind: Kind; ts: number } | null }) {
  useEffect(() => {
    if (!trigger) return;
    const { kind } = trigger;
    if (kind === "confetti") {
      confetti({
        particleCount: 180,
        spread: 90,
        origin: { y: 0.6 },
        colors: ["#ff4d8d", "#ffd166", "#06d6a0", "#ffffff"],
      });
    } else if (kind === "fireworks") {
      const end = Date.now() + 1500;
      (function frame() {
        confetti({ particleCount: 6, angle: 60, spread: 60, origin: { x: 0 }, colors: ["#ff4d8d", "#ffd166"] });
        confetti({ particleCount: 6, angle: 120, spread: 60, origin: { x: 1 }, colors: ["#06d6a0", "#ffffff"] });
        if (Date.now() < end) requestAnimationFrame(frame);
      })();
    } else if (kind === "birthday") {
      confetti({ particleCount: 250, spread: 160, startVelocity: 55, origin: { y: 0.5 }, colors: ["#ffd166", "#ff4d8d"] });
    }
    // 'clap' has no canvas effect; the floating emoji layer handles it.
  }, [trigger]);

  return null;
}
