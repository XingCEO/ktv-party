import React, { forwardRef, isValidElement, cloneElement, type HTMLAttributes, type ReactElement } from "react";
import { cn } from "@/lib/cn";
import { Spinner } from "./Spinner";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost" | "gold" | "mic" | "danger";
  size?: "sm" | "md" | "lg" | "icon";
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  /**
   * When true, render the single child element instead of a `<button>`,
   * forwarding ref + className + disabled-state styling. Avoids invalid
   * `<a>`-inside-`<button>` markup when wrapping <Link>.
   */
  asChild?: boolean;
}

const baseStyles =
  "inline-flex items-center justify-center rounded-xl font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ktv-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-ktv-bg active:scale-[0.97]";

const VARIANTS = {
  primary: "bg-gradient-to-br from-ktv-accent to-[#e0336e] text-white shadow-lg shadow-ktv-accent/20 hover:shadow-ktv-accent/40",
  ghost: "bg-white/5 text-white/90 hover:bg-white/10 active:bg-white/5",
  gold: "bg-gradient-to-br from-ktv-gold to-[#e6b84d] text-black shadow-lg shadow-ktv-gold/20 hover:shadow-ktv-gold/40 hover:shadow-neon",
  mic: "bg-ktv-mic text-black shadow-lg shadow-ktv-mic/20 hover:shadow-ktv-mic/40",
  danger: "bg-red-500/20 text-red-400 hover:bg-red-500/30 hover:text-red-300",
} as const;

const SIZES = {
  sm: "px-3 py-1.5 text-sm",
  md: "px-5 py-2.5 text-base",
  lg: "px-6 py-3.5 text-lg",
  icon: "p-2.5",
} as const;

export const Button = forwardRef<HTMLElement, ButtonProps>(
  (
    {
      className,
      variant = "primary",
      size = "md",
      loading = false,
      leftIcon,
      rightIcon,
      asChild = false,
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const isDisabled = disabled || loading;
    const merged = cn(
      baseStyles,
      VARIANTS[variant],
      SIZES[size],
      isDisabled && "opacity-60 cursor-not-allowed active:scale-100",
      className
    );

    const content = (
      <>
        {loading && <Spinner size={size === "sm" ? "xs" : "sm"} className="mr-2" />}
        {!loading && leftIcon && <span className="mr-2">{leftIcon}</span>}
        {children}
        {!loading && rightIcon && <span className="ml-2">{rightIcon}</span>}
      </>
    );

    // asChild: clone the single child element, merging className + ref. This
    // avoids nesting interactive elements (e.g. <Button asChild><Link/></Button>
    // would otherwise produce <a> inside <button>, which is invalid HTML).
    if (asChild && isValidElement(children)) {
      const childEl = children as ReactElement<HTMLAttributes<HTMLElement>>;
      return cloneElement(childEl, {
        ...props,
        ref: ref as React.Ref<HTMLElement>,
        className: cn(merged, childEl.props.className),
        // If the underlying element supports aria-disabled, propagate disabled.
        "aria-disabled": isDisabled || undefined,
        // Respect existing onClick: block when disabled.
        onClick: (e: React.MouseEvent<HTMLElement>) => {
          if (isDisabled) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          (childEl.props as { onClick?: React.MouseEventHandler<HTMLElement> }).onClick?.(e);
        },
      } as HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> });
    }

    return (
      <button
        ref={ref as React.Ref<HTMLButtonElement>}
        disabled={isDisabled}
        className={merged}
        {...props}
      >
        {content}
      </button>
    );
  }
);

Button.displayName = "Button";
