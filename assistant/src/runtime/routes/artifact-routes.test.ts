import { describe, expect, test } from "bun:test";

import { ROUTES } from "./artifact-routes.js";
import { BadRequestError } from "./errors.js";

describe("artifact routes", () => {
  test("exposes brand, list, detail, and update routes with policies", () => {
    expect(ROUTES.map((route) => `${route.method} ${route.endpoint}`)).toEqual([
      "GET brands",
      "GET artifacts",
      "GET artifacts/:id",
      "PATCH artifacts/:id",
    ]);
    expect(ROUTES.every((route) => route.policy != null)).toBe(true);
  });

  test("documents query filters in OpenAPI metadata", () => {
    const list = ROUTES.find((route) => route.operationId === "listArtifacts")!;
    expect(list.queryParams?.map((param) => param.name)).toEqual([
      "brandId",
      "type",
      "search",
      "status",
      "favorite",
    ]);
  });

  test("rejects invalid favorite query values", () => {
    const list = ROUTES.find((route) => route.operationId === "listArtifacts")!;
    expect(() =>
      list.handler({ queryParams: { favorite: "sometimes" } }),
    ).toThrow(BadRequestError);
  });

  test("requires at least one artifact update", () => {
    const update = ROUTES.find(
      (route) => route.operationId === "updateArtifact",
    )!;
    const schema = update.requestBody as import("zod").ZodType;
    expect(schema.safeParse({ favorite: true }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });
});
