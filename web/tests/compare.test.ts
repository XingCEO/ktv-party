import { describe, it, expect } from "vitest";
import { shallowEqualArrayById, isEqualQueue } from "../lib/compare";

describe("shallowEqualArrayById", () => {
  it("returns true for identical arrays", () => {
    expect(shallowEqualArrayById([{ id: 1 }, { id: 2 }], [{ id: 1 }, { id: 2 }])).toBe(true);
  });

  it("returns false for different lengths", () => {
    expect(shallowEqualArrayById([{ id: 1 }], [{ id: 1 }, { id: 2 }])).toBe(false);
  });

  it("returns false for different ids", () => {
    expect(shallowEqualArrayById([{ id: 1 }, { id: 2 }], [{ id: 1 }, { id: 3 }])).toBe(false);
  });
});

describe("isEqualQueue", () => {
  const a = [{ id: 1, status: 'playing', position: 1, vocal_mode: 'vocal' }];
  
  it("returns true for identical queues", () => {
    const b = [{ id: 1, status: 'playing', position: 1, vocal_mode: 'vocal' }];
    expect(isEqualQueue(a, b)).toBe(true);
  });

  it("returns false for different lengths", () => {
    expect(isEqualQueue(a, [])).toBe(false);
  });

  it("returns false for different status", () => {
    const b = [{ id: 1, status: 'queued', position: 1, vocal_mode: 'vocal' }];
    expect(isEqualQueue(a, b)).toBe(false);
  });

  it("returns false for different position", () => {
    const b = [{ id: 1, status: 'playing', position: 2, vocal_mode: 'vocal' }];
    expect(isEqualQueue(a, b)).toBe(false);
  });

  it("returns false for different vocal_mode", () => {
    const b = [{ id: 1, status: 'playing', position: 1, vocal_mode: 'instrumental' }];
    expect(isEqualQueue(a, b)).toBe(false);
  });
});
