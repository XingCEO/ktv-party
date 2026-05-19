import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// jsdom defines window.scrollTo/scrollBy as functions that log
// "Not implemented" — drowning useful test output. Replace them outright.
// vi.stubGlobal works cleanly because jsdom's globals live on `globalThis`.
vi.stubGlobal("scrollTo", () => {});
vi.stubGlobal("scrollBy", () => {});

// matchMedia is used by Tailwind reduced-motion check + some framer-motion
// paths; jsdom doesn't implement it.
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    value: (q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
    writable: true,
  });
}

if (typeof window !== "undefined") {
  Object.defineProperty(window.HTMLMediaElement.prototype, "load", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: vi.fn(async () => undefined),
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value: vi.fn(),
  });
}
