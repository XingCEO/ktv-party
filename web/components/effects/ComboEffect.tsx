"use client";
import { useEffect } from "react";
import confetti from "canvas-confetti";

export type ComboTrigger = { kind: string; count: number; multiplier: number; ts: number } | null;

/**
 * Mega-effect when atmosphere.combo arrives. Renders nothing visible, but
 * fires an over-the-top confetti burst proportional to combo multiplier.
 */
export default function ComboEffect({ trigger }: { trigger: ComboTrigger }) {
  useEffect(() => {
    if (!trigger) return;
    const { kind, multiplier } = trigger;
    const particles = 80 * multiplier;
    const colors: Record<string, string[]> = {
      confetti: ["#ff4d8d", "#ffd166", "#06d6a0", "#ffffff"],
      fireworks: ["#ff4d8d", "#ffd166"],
      clap: ["#ffffff", "#ffd166"],
      birthday: ["#ffd166", "#ff4d8d", "#ffffff"],
    };
    const colorPalette = colors[kind] || colors.confetti;
    // Center burst
    confetti({ particleCount: particles, spread: 120, startVelocity: 60, origin: { y: 0.5 }, colors: colorPalette });
    // Side bursts
    setTimeout(() => confetti({ particleCount: particles / 2, angle: 60, spread: 80, origin: { x: 0, y: 0.6 }, colors: colorPalette }), 100);
    setTimeout(() => confetti({ particleCount: particles / 2, angle: 120, spread: 80, origin: { x: 1, y: 0.6 }, colors: colorPalette }), 200);
  }, [trigger]);
  return null;
}
