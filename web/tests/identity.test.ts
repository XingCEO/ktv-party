import { describe, it, expect, beforeEach } from "vitest";
import { ensureIdentity, getIdentity, clearIdentity } from "@/lib/identity";

describe("identity", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns null when nothing stored", () => {
    expect(getIdentity()).toBeNull();
  });

  it("creates and persists identity", () => {
    const a = ensureIdentity("Alice");
    expect(a.nickname).toBe("Alice");
    expect(a.user_id).toBeTruthy();
    const b = getIdentity();
    expect(b?.user_id).toBe(a.user_id);
  });

  it("preserves user_id when nickname changes", () => {
    const a = ensureIdentity("Alice");
    const b = ensureIdentity("Bob");
    expect(b.user_id).toBe(a.user_id);
    expect(b.nickname).toBe("Bob");
  });

  it("clears identity", () => {
    ensureIdentity("Alice");
    clearIdentity();
    expect(getIdentity()).toBeNull();
  });

  it("handles malformed JSON gracefully", () => {
    window.localStorage.setItem("ktv-identity-v1", "{not json");
    expect(getIdentity()).toBeNull();
  });
});
