import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { WORKLIN_AVATAR_CHOICES } from "@/components/avatar/assistant-character-packs";
import { WorklinAvatarRosterArt } from "./worklin-avatar-roster-art";

afterEach(() => {
  cleanup();
});

describe("WorklinAvatarRosterArt", () => {
  test("renders the six Worklin avatar posters", () => {
    const { container } = render(<WorklinAvatarRosterArt />);
    const images = Array.from(container.querySelectorAll("img"));
    expect(images).toHaveLength(WORKLIN_AVATAR_CHOICES.length);
    expect(images.every((image) => image.getAttribute("alt") === "")).toBe(true);
    expect(images[0]?.getAttribute("src")).toMatch(/spiky-spark-poster\.jpg$/);
  });

  test("stays decorative and non-interactive", () => {
    const { container } = render(<WorklinAvatarRosterArt />);
    const art = container.firstElementChild;
    expect(art?.getAttribute("aria-hidden")).toBe("true");
    expect(art?.className).toContain("pointer-events-none");
  });
});
