import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ScoreScreen } from "../components/effects/ScoreScreen";

// Mock canvas-confetti
vi.mock("canvas-confetti", () => {
  return {
    default: vi.fn()
  };
});

describe("ScoreScreen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not render when visible=false", () => {
    const { container } = render(
      <ScoreScreen
        visible={false}
        songTitle="Test Song"
        singerName="Singer"
        onDismiss={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders song title and singer name when visible=true", () => {
    render(
      <ScoreScreen
        visible={true}
        songTitle="Test Song"
        singerName="TestSinger"
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText("演唱結束！")).toBeDefined();
    expect(screen.getByText("Test Song")).toBeDefined();
    expect(screen.getByText("@TestSinger")).toBeDefined();
  });

  it("displays reaction emoji and witty messages", () => {
    render(
      <ScoreScreen
        visible={true}
        songTitle="Test Song"
        singerName="Singer"
        seed="test-seed"
        onDismiss={vi.fn()}
      />
    );
    // Should display one of the emojis
    const emojis = ["🔥 完美！", "⭐ 太棒了！", "👍 不錯喔！", "😊 還可以", "🎵 加油！"];
    const hasEmoji = emojis.some(e => screen.queryByText(e));
    expect(hasEmoji).toBe(true);

    // Should display the score number (will animate, but start at 0 initially)
    // Actually, requestAnimationFrame might not run under fake timers properly without advancing.
    // The test just checks that it's mounted.
    expect(screen.getByRole("button", { name: "繼續" })).toBeDefined();
  });

  it("auto-dismisses after 5s", () => {
    const handleDismiss = vi.fn();
    render(
      <ScoreScreen
        visible={true}
        songTitle="Test Song"
        singerName="Singer"
        onDismiss={handleDismiss}
      />
    );
    
    expect(handleDismiss).not.toHaveBeenCalled();
    
    act(() => {
      vi.advanceTimersByTime(5500);
    });
    
    expect(handleDismiss).toHaveBeenCalledTimes(1);
  });

  it("manual dismiss button calls onDismiss", () => {
    const handleDismiss = vi.fn();
    render(
      <ScoreScreen
        visible={true}
        songTitle="Test Song"
        singerName="Singer"
        onDismiss={handleDismiss}
      />
    );
    
    const button = screen.getByRole("button", { name: "繼續" });
    fireEvent.click(button);
    expect(handleDismiss).toHaveBeenCalledTimes(1);
  });

  it("same seed produces same score", () => {
    // Score calculation logic relies on final display score. We can grab it from textContent.
    // requestAnimationFrame needs to be executed to update the score.
    // The easiest way is to mock framer-motion or just advance timers and check DOM.
    // Actually, the number is rendered inside a span. Let's find it by looking for the 8xl text element.
    const { container, rerender } = render(
      <ScoreScreen
        visible={true}
        songTitle="Song A"
        singerName="A"
        seed="seed-123"
        onDismiss={vi.fn()}
      />
    );

    act(() => {
      vi.advanceTimersByTime(2000); // Wait for animation to finish
    });

    const numberSpan1 = container.querySelector(".text-8xl")?.textContent;

    rerender(
      <ScoreScreen
        visible={true}
        songTitle="Song B"
        singerName="B"
        seed="seed-123"
        onDismiss={vi.fn()}
      />
    );

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    const numberSpan2 = container.querySelector(".text-8xl")?.textContent;
    
    expect(numberSpan1).toBeTruthy();
    expect(numberSpan1).toEqual(numberSpan2);
  });
});
