import { describe, expect, test } from "bun:test";

import { ROUTES } from "./shared-artifact-routes.js";

describe("shared artifact routes", () => {
  test("exposes only the scoped Copybook read, comment, and edit surface", () => {
    expect(ROUTES.map((route) => `${route.method} ${route.endpoint}`)).toEqual([
      "GET shared-artifacts/:artifactId/snapshot",
      "PATCH shared-artifacts/:artifactId/months/:monthId/document",
      "GET shared-artifacts/:artifactId/months/:monthId/comments",
      "POST shared-artifacts/:artifactId/months/:monthId/comments",
    ]);
  });

  test("keeps role permissions distinct", () => {
    expect(ROUTES[0]?.policy?.requiredScopes).toEqual(["artifact.read"]);
    expect(ROUTES[1]?.policy?.requiredScopes).toEqual(["artifact.write"]);
    expect(ROUTES[2]?.policy?.requiredScopes).toEqual(["artifact.read"]);
    expect(ROUTES[3]?.policy?.requiredScopes).toEqual(["artifact.comment"]);
  });
});
