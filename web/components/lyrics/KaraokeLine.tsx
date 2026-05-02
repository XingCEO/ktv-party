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
  // Split into characters for CJK, or words for non-CJK.
  // The regex splits by CJK chars, or continuous word chars, or spaces, or any other char.
  const tokens = text.match(/[\u4e00-\u9fa5]|[a-zA-Z0-9_]+|\s+|./g) || Array.from(text);

  const duration = endSec - startSec;
  const progress = duration > 0 
    ? Math.max(0, Math.min(1, (currentSec - startSec) / duration))
    : (currentSec >= endSec ? 1 : 0);

  return (
    <div className={cn("inline-block", className)}>
      {tokens.map((token, i) => {
        const threshold = i / tokens.length;
        const isFilled = progress > threshold;
        
        return (
          <span
            key={`${i}-${token}`}
            className={cn(
              "transition-colors duration-200",
              isFilled
                ? "text-ktv-gold drop-shadow-[0_0_12px_rgba(255,209,102,0.8)]"
                : "text-white/50"
            )}
          >
            {token}
          </span>
        );
      })}
    </div>
  );
}
