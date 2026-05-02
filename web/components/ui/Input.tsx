import React, { forwardRef } from "react";
import { cn } from "@/lib/cn";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  variant?: "default" | "search";
  error?: string;
  leftIcon?: React.ReactNode;
  rightAddon?: React.ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, variant = "default", error, leftIcon, rightAddon, ...props }, ref) => {
    // If it's a search variant, we supply a default leftIcon if none provided
    const _leftIcon =
      variant === "search" && !leftIcon ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-5 w-5 text-white/40"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      ) : (
        leftIcon
      );

    return (
      <div className="relative w-full">
        <div className="relative flex items-center w-full">
          {_leftIcon && (
            <div className="absolute left-3 flex items-center justify-center pointer-events-none">
              {_leftIcon}
            </div>
          )}
          <input
            ref={ref}
            className={cn(
              "w-full bg-white/[0.06] border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-white/40 transition-all duration-200 outline-none",
              "focus:border-ktv-accent/70 focus:ring-1 focus:ring-ktv-accent/70 focus:bg-white/[0.08]",
              _leftIcon && "pl-10",
              rightAddon && "pr-14",
              error && "border-red-500/70 focus:border-red-500 focus:ring-red-500/50",
              className
            )}
            {...props}
          />
          {rightAddon && (
            <div className="absolute right-3 flex items-center justify-center">
              {rightAddon}
            </div>
          )}
        </div>
        {error && (
          <p className="mt-1.5 text-sm text-red-400 animate-fade-up">
            {error}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = "Input";
