import { describe, expect, test } from "bun:test";

import { ROUTES } from "./copybook-routes.js";

describe("copybook routes", () => {
  test("exposes the complete MVP route surface with explicit policies", () => {
    expect(ROUTES.map((route) => `${route.method} ${route.endpoint}`)).toEqual([
      "GET copybooks",
      "POST copybooks",
      "GET copybooks/:id",
      "POST copybooks/:id/months",
      "PATCH copybook-months/:id",
      "POST copybook-months/:id/campaigns",
      "PATCH copybook-campaigns/:id",
      "POST copybook-campaigns/:id/approve",
      "POST copybook-campaigns/:id/ready-for-design",
    ]);
    expect(ROUTES.every((route) => route.policy != null)).toBe(true);
  });

  test("reserves approval and ready-for-design for explicit endpoints", () => {
    const update = ROUTES.find(
      (route) => route.operationId === "updateCopybookCampaign",
    )!;
    const schema = update.requestBody as import("zod").ZodType;
    expect(schema.safeParse({ status: "copy_review" }).success).toBe(true);
    expect(schema.safeParse({ status: "approved" }).success).toBe(false);
    expect(schema.safeParse({ status: "ready_for_design" }).success).toBe(
      false,
    );
  });
});
