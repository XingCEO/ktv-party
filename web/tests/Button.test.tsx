import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Button } from "../components/ui/Button";

describe("Button", () => {
  it("renders a <button> by default", () => {
    render(<Button>Click me</Button>);
    const btn = screen.getByRole("button", { name: "Click me" });
    expect(btn.tagName).toBe("BUTTON");
  });

  it("applies variant + size classes", () => {
    render(<Button variant="gold" size="lg">Go</Button>);
    const btn = screen.getByRole("button", { name: "Go" });
    expect(btn.className).toMatch(/bg-gradient-to-br/);
    expect(btn.className).toMatch(/from-ktv-gold/);
    expect(btn.className).toMatch(/text-lg/);
  });

  it("disables button when loading and shows spinner", () => {
    render(<Button loading>Submitting</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    // Spinner has 3 bouncing dots
    expect(btn.querySelectorAll("div.animate-bounce").length).toBe(3);
  });

  it("merges custom className", () => {
    render(<Button className="custom-x">x</Button>);
    expect(screen.getByRole("button").className).toContain("custom-x");
  });

  describe("asChild", () => {
    it("renders the single child instead of a <button> (no nested interactive)", () => {
      render(
        <Button asChild variant="primary">
          <a href="/somewhere">Go There</a>
        </Button>
      );
      // The link should be the primary rendered element — NO surrounding <button>.
      const link = screen.getByRole("link", { name: "Go There" });
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("href")).toBe("/somewhere");
      // Critically: there should be no <button> wrapping the <a>.
      expect(screen.queryByRole("button")).toBeNull();
    });

    it("forwards Button styling to the child element", () => {
      render(
        <Button asChild variant="gold" size="md" className="extra">
          <a href="/x">link</a>
        </Button>
      );
      const link = screen.getByRole("link");
      expect(link.className).toMatch(/from-ktv-gold/);
      expect(link.className).toMatch(/text-base/);
      expect(link.className).toContain("extra");
    });

    it("preserves child's existing className", () => {
      render(
        <Button asChild>
          <a href="/x" className="child-class">link</a>
        </Button>
      );
      expect(screen.getByRole("link").className).toContain("child-class");
    });

    it("blocks onClick + sets aria-disabled when disabled/loading", () => {
      const onClick = vi.fn();
      render(
        <Button asChild disabled>
          <a href="/x" onClick={onClick}>link</a>
        </Button>
      );
      const link = screen.getByRole("link");
      expect(link.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(link);
      expect(onClick).not.toHaveBeenCalled();
    });
  });
});
