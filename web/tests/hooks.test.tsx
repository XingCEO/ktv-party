import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useStableCallback, useDebounceCallback, useInterval } from "../lib/hooks";

describe("hooks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("useStableCallback", () => {
    it("returns stable identity but calls latest fn", () => {
      let val = 1;
      const { result, rerender } = renderHook(({ fn }) => useStableCallback(fn), {
        initialProps: { fn: () => val },
      });
      const firstFn = result.current;
      expect(firstFn()).toBe(1);

      val = 2;
      rerender({ fn: () => val });
      const secondFn = result.current;

      expect(firstFn).toBe(secondFn); // Identity stable
      expect(secondFn()).toBe(2); // Calls latest
    });
  });

  describe("useDebounceCallback", () => {
    it("fires only once after rapid calls", () => {
      const fn = vi.fn();
      const { result } = renderHook(() => useDebounceCallback(fn, 100));
      
      result.current(1);
      result.current(2);
      result.current(3);

      expect(fn).not.toHaveBeenCalled();
      
      vi.advanceTimersByTime(150);
      
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(3);
    });
  });

  describe("useInterval", () => {
    it("calls cb at expected intervals", () => {
      const fn = vi.fn();
      renderHook(() => useInterval(fn, 100));
      
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("pauses when delay is null", () => {
      const fn = vi.fn();
      const { rerender } = renderHook(({ delay }) => useInterval(fn, delay), {
        initialProps: { delay: 100 as number | null },
      });
      
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);
      
      rerender({ delay: null });
      vi.advanceTimersByTime(200);
      expect(fn).toHaveBeenCalledTimes(1); // Still 1
    });
  });
});
