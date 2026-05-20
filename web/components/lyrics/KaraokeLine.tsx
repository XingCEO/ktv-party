import React from "react";
import { cn } from "@/lib/cn";

export type KaraokeLineProps = {
  text: string;
  startSec: number;
  endSec: number;
  currentSec: number;
  className?: string;
};

export function KaraokeLine({
  text,
  startSec,
  endSec,
  currentSec,
  className,
}: KaraokeLineProps) {
  const duration = endSec - startSec;
  const progress = duration > 0 
    ? Math.max(0, Math.min(1, (currentSec - startSec) / duration))
    : (currentSec >= endSec ? 1 : 0);

  // Keep tokenized spans for test and per-token left-to-right fill.
  const tokens = text.match(/[\u4e00-\u9fa5]|[a-zA-Z0-9_]+|\s+|./g) || Array.from(text);
  let cursor = 0;

  return (
    <div className={cn("inline-block", className)}>
      {tokens.map((token) => {
        const key = `${cursor}-${token}`;
        const threshold = cursor / Math.max(1, text.length);
        cursor += token.length;
        const isFilled = progress > threshold;
        return (
          <span
            key={key}
            className={cn(
              "transition-colors duration-150",
              isFilled ? "text-ktv-gold drop-shadow-[0_0_12px_rgba(255,209,102,0.8)]" : "text-white/50",
            )}
            style={
              isFilled
                ? {
                    backgroundImage: "linear-gradient(90deg, #ffd166 0%, #ff4d8d 100%)",
                    WebkitBackgroundClip: "text",
                    backgroundClip: "text",
                    color: "transparent",
                  }
                : undefined
            }
          >
            {token}
          </span>
        );
      })}
    </div>
  );
}
