import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { KaraokeLine } from "../components/lyrics/KaraokeLine";

describe("KaraokeLine", () => {
  it("renders all chars unfilled when currentSec < startSec", () => {
    const { container } = render(
      <KaraokeLine text="A B C D" startSec={2} endSec={4} currentSec={1} />
    );
    const spans = container.querySelectorAll("span");
    expect(spans).toHaveLength(7); // 4 letters + 3 spaces
    spans.forEach((span) => {
      expect(span.className).toContain("text-white/50");
      expect(span.className).not.toContain("text-ktv-gold");
    });
  });

  it("renders all chars filled when currentSec >= endSec", () => {
    const { container } = render(
      <KaraokeLine text="A B C D" startSec={2} endSec={4} currentSec={4.5} />
    );
    const spans = container.querySelectorAll("span");
    expect(spans).toHaveLength(7);
    spans.forEach((span) => {
      expect(span.className).toContain("text-ktv-gold");
      expect(span.className).not.toContain("text-white/50");
    });
  });

  it("renders partial fill when currentSec is mid-line", () => {
    const { container } = render(
      <KaraokeLine text="A B C D" startSec={0} endSec={4} currentSec={2} />
    );
    const spans = container.querySelectorAll("span");
    expect(spans).toHaveLength(7);
    
    // progress is 2/4 = 0.5. 
    // thresholds: 0/7, 1/7, 2/7, 3/7 (0.42), 4/7 (0.57)
    // 0,1,2,3 should be filled
    
    expect(spans[0].className).toContain("text-ktv-gold");
    expect(spans[3].className).toContain("text-ktv-gold");
    expect(spans[4].className).toContain("text-white/50");
  });

  it("handles empty text gracefully", () => {
    const { container } = render(
      <KaraokeLine text="" startSec={0} endSec={4} currentSec={2} />
    );
    const spans = container.querySelectorAll("span");
    expect(spans).toHaveLength(0);
  });

  it("handles endSec <= startSec without dividing by zero", () => {
    // If endSec <= startSec, lineDuration is <= 0.
    // Progress is set to 1 if currentSec >= endSec, else 0.
    const { container, rerender } = render(
      <KaraokeLine text="A B C D" startSec={2} endSec={2} currentSec={1} />
    );
    let spans = container.querySelectorAll("span");
    expect(spans[0].className).toContain("text-white/50"); // current < endSec

    rerender(<KaraokeLine text="A B C D" startSec={2} endSec={2} currentSec={2.5} />);
    spans = container.querySelectorAll("span");
    expect(spans[0].className).toContain("text-ktv-gold"); // current >= endSec
  });
});
