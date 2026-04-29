import { describe, it, expect } from "vitest";
import { buildPhoneUrl } from "@/lib/qr";

describe("buildPhoneUrl", () => {
  it("joins origin and roomId cleanly", () => {
    expect(buildPhoneUrl("http://192.168.1.5:3000", "abc")).toBe("http://192.168.1.5:3000/m/abc");
  });
  it("strips trailing slashes", () => {
    expect(buildPhoneUrl("http://x.local///", "r1")).toBe("http://x.local/m/r1");
  });
});
