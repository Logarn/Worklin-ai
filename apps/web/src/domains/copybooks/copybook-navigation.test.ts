import { describe, expect, test } from "bun:test";

import type { CopybookDetail } from "./copybook-api";
import {
  copybookStartPrompt,
  copybookWorklinPrompt,
  getCopybookDestination,
} from "./copybook-navigation";

function detail(months: number[]): CopybookDetail {
  return {
    copybook: {
      id: "copybook-1",
      brandId: "brand-1",
      year: 2026,
      title: "2026 Copybook",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
    },
    brand: { id: "brand-1", name: "Acme" },
    brandBrain: null,
    months: months.map((month) => ({
      id: `month-${month}`,
      copybookId: "copybook-1",
      month,
      documentSurfaceId: null,
      strategyStatus: "draft",
      createdAt: 1,
      updatedAt: 2,
      campaigns: [],
    })),
  };
}

describe("copybook index navigation", () => {
  test("opens the earliest existing month", () => {
    expect(getCopybookDestination(detail([7, 3, 11]))).toBe(
      "/assistant/work/brands/brand-1/artifacts/copybooks/copybook-1/2026/3",
    );
  });

  test("returns no detail destination until a month exists", () => {
    expect(getCopybookDestination(detail([]))).toBeNull();
  });

  test("asks Worklin to stop at the strategy review gate", () => {
    expect(copybookStartPrompt("Acme 2026")).toContain(
      "Stop for my review before writing campaign copy",
    );
  });

  test("continues in the open month document without replacing human work", () => {
    const prompt = copybookWorklinPrompt({
      title: "2026 Copybook",
      year: 2026,
      month: 8,
    });

    expect(prompt).toContain("August 2026 campaign copybook");
    expect(prompt).toContain("linked month document is already open");
    expect(prompt).toContain("Read my comments");
    expect(prompt).toContain("make targeted edits");
    expect(prompt).toContain("do not create another document");
  });
});
