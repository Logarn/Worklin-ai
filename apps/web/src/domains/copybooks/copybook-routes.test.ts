import { describe, expect, test } from "bun:test";

import { routes } from "@/utils/routes";

describe("copybook routes", () => {
  test("exposes the copybook index", () => {
    expect(routes.copybooks.root).toBe("/assistant/copybooks");
  });

  test("builds a stable month deep link", () => {
    expect(routes.copybooks.month("copybook-1", 2026, 1)).toBe(
      "/assistant/copybooks/copybook-1/2026/1",
    );
  });
});
