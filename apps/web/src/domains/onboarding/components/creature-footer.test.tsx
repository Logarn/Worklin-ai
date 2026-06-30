import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { CreatureFooter } from "./creature-footer";

afterEach(() => {
  cleanup();
});

describe("CreatureFooter", () => {
  test("renders the decorative Worklin avatar lineup", () => {
    const { container } = render(<CreatureFooter />);
    const images = Array.from(container.querySelectorAll("img"));
    expect(images).toHaveLength(6);
    expect(images.every((img) => img.getAttribute("alt") === "")).toBe(true);
    expect(images[0]?.getAttribute("src")).toMatch(/spiky-spark-poster\.jpg$/);
  });

  test("pins the container to the physical bottom with `fixed` (not `absolute`)", () => {
    const { container } = render(<CreatureFooter />);
    const footer = container.querySelector("div");
    expect(footer?.className).toContain("fixed");
    expect(footer?.className).toContain("bottom-0");
    expect(footer?.className).not.toContain("absolute");
  });

  test("forwards a passed className", () => {
    const { container } = render(<CreatureFooter className="test-extra" />);
    const footer = container.querySelector("div");
    expect(footer?.className).toContain("test-extra");
  });

  test("is decorative and non-interactive", () => {
    const { container } = render(<CreatureFooter />);
    const footer = container.querySelector("div");
    expect(footer?.getAttribute("aria-hidden")).toBe("true");
    expect(footer?.className).toContain("pointer-events-none");
  });
});
