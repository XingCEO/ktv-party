import React, { forwardRef } from "react";
import { cn } from "@/lib/cn";
import { ButtonProps, Button } from "./Button";

export interface IconButtonProps extends Omit<ButtonProps, "children" | "leftIcon" | "rightIcon" | "aria-label"> {
  "aria-label": string; // REQUIRED
  icon: React.ReactNode;
  round?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, icon, round = false, size = "icon", "aria-label": ariaLabel, ...props }, ref) => {
    return (
      <Button
        ref={ref}
        size={size}
        aria-label={ariaLabel}
        className={cn(round ? "rounded-full" : "rounded-xl", className)}
        {...props}
      >
        {icon}
      </Button>
    );
  }
);
IconButton.displayName = "IconButton";
