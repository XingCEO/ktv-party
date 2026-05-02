"use client";

import React, { createContext, useContext, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/cn";

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface ToastOptions {
  variant?: ToastVariant;
  title?: string;
  message: string;
}

export interface ToastItem extends ToastOptions {
  id: string;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context.toast;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback((options: ToastOptions) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { ...options, id }]);

    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const getVariantStyles = (variant: ToastVariant = "info") => {
    switch (variant) {
      case "success":
        return "bg-ktv-mic/10 border-ktv-mic/40 text-ktv-mic shadow-[0_0_20px_rgba(6,214,160,0.2)]";
      case "warning":
        return "bg-ktv-gold/10 border-ktv-gold/40 text-ktv-gold shadow-[0_0_20px_rgba(255,209,102,0.2)]";
      case "error":
        return "bg-red-500/10 border-red-500/40 text-red-400 shadow-[0_0_20px_rgba(239,68,68,0.2)]";
      case "info":
      default:
        return "bg-white/10 border-white/20 text-white shadow-xl";
    }
  };

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      <div className="fixed z-50 flex flex-col gap-3 pointer-events-none p-4 tv:top-4 tv:right-4 tv:bottom-auto tv:left-auto bottom-safe-bottom left-1/2 -translate-x-1/2 tv:translate-x-0 w-full max-w-sm">
        <AnimatePresence mode="popLayout">
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 50, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
              onClick={() => dismissToast(t.id)}
              className={cn(
                "pointer-events-auto cursor-pointer p-4 rounded-xl border backdrop-blur-md flex flex-col gap-1",
                getVariantStyles(t.variant)
              )}
            >
              {t.title && <div className="font-bold text-sm opacity-90">{t.title}</div>}
              <div className="text-sm font-medium">{t.message}</div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
