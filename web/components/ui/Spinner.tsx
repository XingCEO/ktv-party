import React from "react";
import { cn } from "@/lib/cn";

export interface SpinnerProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: "xs" | "sm" | "md";
}

export const Spinner = ({ size = "sm", className, ...props }: SpinnerProps) => {
  const sizeStyles = {
    xs: "w-1 h-1",
    sm: "w-1.5 h-1.5",
    md: "w-2 h-2",
  };

  const dotClass = cn(
    "bg-current rounded-full animate-bounce",
    sizeStyles[size]
  );

  return (
    <div
      className={cn("inline-flex items-center justify-center space-x-1", className)}
      {...props}
    >
      <div className={dotClass} style={{ animationDelay: "0ms" }} />
      <div className={dotClass} style={{ animationDelay: "150ms" }} />
      <div className={dotClass} style={{ animationDelay: "300ms" }} />
    </div>
  );
};
