import { describe, it, expect, vi, afterEach } from "vitest";
import { fmtDuration, api } from "@/lib/api";

function mockFetchOnce(status: number, body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    })),
  );
}

describe("api req() error surfacing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("surfaces structured {detail:{message}} as the error message", async () => {
    mockFetchOnce(429, JSON.stringify({ detail: { code: "rate_limited", message: "已被 YouTube 限流，請稍後再試" } }));
    await expect(api.listRooms()).rejects.toThrow("已被 YouTube 限流，請稍後再試");
  });

  it("surfaces a plain string detail", async () => {
    mockFetchOnce(404, JSON.stringify({ detail: "room not found" }));
    await expect(api.listRooms()).rejects.toThrow("room not found");
  });

  it("falls back to a status message for non-JSON bodies", async () => {
    mockFetchOnce(500, "<html>boom</html>");
    await expect(api.listRooms()).rejects.toThrow("<html>boom</html>");
  });
});

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
