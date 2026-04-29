import { describe, it, expect } from "vitest";
import { fmtDuration } from "@/lib/api";

describe("fmtDuration", () => {
  it("formats seconds into m:ss", () => {
    expect(fmtDuration(0)).toBe("0:00");
    expect(fmtDuration(5)).toBe("0:05");
    expect(fmtDuration(65)).toBe("1:05");
    expect(fmtDuration(3725)).toBe("62:05");
  });

  it("returns placeholder for null/NaN/undefined", () => {
    expect(fmtDuration(null)).toBe("--:--");
    expect(fmtDuration(undefined)).toBe("--:--");
    expect(fmtDuration(NaN)).toBe("--:--");
  });
});
