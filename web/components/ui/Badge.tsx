import React, { forwardRef } from "react";
import { cn } from "@/lib/cn";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "gold" | "mic" | "accent" | "outline";
  size?: "sm" | "md";
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = "default", size = "sm", ...props }, ref) => {
    const variants = {
      default: "bg-white/10 text-white/90",
      gold: "bg-ktv-gold/20 text-ktv-gold border border-ktv-gold/30 shadow-[0_0_12px_rgba(255,209,102,0.3)]",
      mic: "bg-ktv-mic/20 text-ktv-mic border border-ktv-mic/30 shadow-[0_0_12px_rgba(6,214,160,0.3)]",
      accent: "bg-ktv-accent/20 text-ktv-accent border border-ktv-accent/30",
      outline: "border border-white/20 text-white/70",
    };

    const sizes = {
      sm: "px-2 py-0.5 text-xs",
      md: "px-2.5 py-1 text-sm",
    };

    return (
      <span
        ref={ref}
        className={cn(
          "inline-flex items-center rounded-full font-medium transition-colors",
          variants[variant],
          sizes[size],
          className
        )}
        {...props}
      />
    );
  }
);
Badge.displayName = "Badge";
