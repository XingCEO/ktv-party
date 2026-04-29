import { describe, it, expect } from "vitest";
import { cn } from "@/lib/cn";

describe("cn", () => {
  it("merges classes and dedupes tailwind conflicts", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
    expect(cn("text-white", false && "hidden", "bg-black")).toBe("text-white bg-black");
  });
});
