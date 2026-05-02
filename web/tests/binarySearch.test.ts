import { describe, it, expect, vi } from "vitest";
import { lastTrueIndex } from "../lib/binarySearch";

describe("lastTrueIndex", () => {
  it("returns -1 for empty array", () => {
    expect(lastTrueIndex([], () => true)).toBe(-1);
  });

  it("returns last index if all true", () => {
    expect(lastTrueIndex([1, 2, 3], () => true)).toBe(2);
  });

  it("returns -1 if all false", () => {
    expect(lastTrueIndex([1, 2, 3], () => false)).toBe(-1);
  });

  it("finds correct index for mixed monotonic predicate", () => {
    const arr = [{ time: 1 }, { time: 2 }, { time: 3 }, { time: 4 }];
    expect(lastTrueIndex(arr, x => x.time <= 2.5)).toBe(1);
  });

  it("uses hint to walk forward", () => {
    const arr = [1, 2, 3, 4, 5];
    const pred = vi.fn(x => x <= 3);
    expect(lastTrueIndex(arr, pred, 1)).toBe(2);
    // Should check hint (1), then 2, then 3, finding 3 is false, and stop.
    // That means it checks indices 1, 2, 3.
    expect(pred).toHaveBeenCalledTimes(3);
  });

  it("falls back to binary search if hint is too stale (pred(hint) is false)", () => {
    const arr = [1, 2, 3, 4, 5];
    const pred = vi.fn(x => x <= 2);
    // hint is 3, arr[3] is 4, pred(4) is false -> falls back to binary search
    expect(lastTrueIndex(arr, pred, 3)).toBe(1);
  });
});
