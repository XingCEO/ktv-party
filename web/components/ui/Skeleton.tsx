import React, { forwardRef } from "react";
import { cn } from "@/lib/cn";

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  rounded?: boolean;
}

export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(
  ({ className, rounded = false, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "animate-pulse bg-white/10",
          rounded ? "rounded-full" : "rounded-xl",
          className
        )}
        {...props}
      />
    );
  }
);
Skeleton.displayName = "Skeleton";
