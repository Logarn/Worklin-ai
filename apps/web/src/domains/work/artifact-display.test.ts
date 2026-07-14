import { describe, expect, test } from "bun:test";

import type { RegistryArtifact } from "./artifact-display";
import {
  artifactMatchesFilter,
  getArtifactDestination,
  getArtifactDetail,
  getArtifactDisplayFilter,
} from "./artifact-display";

function artifact(
  overrides: Partial<RegistryArtifact> = {},
): RegistryArtifact {
  return {
    id: "artifact-1",
    brandId: "brand-1",
    resourceType: "asset",
    resourceId: "resource-1",
    artifactType: "unknown",
    parentArtifactId: null,
    projectId: null,
    metadata: null,
    favorite: false,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    title: "Artifact",
    sourceExists: true,
    childCount: 0,
    ...overrides,
  };
}

describe("artifact display mapping", () => {
  test("groups open-ended artifact types under stable filters", () => {
    expect(getArtifactDisplayFilter(artifact({ artifactType: "email_copy" }))).toBe("copy");
    expect(getArtifactDisplayFilter(artifact({ artifactType: "product_image" }))).toBe("images");
    expect(getArtifactDisplayFilter(artifact({ artifactType: "facebook_post" }))).toBe("social");
    expect(artifactMatchesFilter(artifact({ resourceType: "app" }), "apps")).toBe(true);
    expect(artifactMatchesFilter(artifact(), "all")).toBe(true);
  });

  test("keeps unknown types visible in All without misclassifying them", () => {
    const item = artifact({ artifactType: "three_dimensional_model" });
    expect(getArtifactDisplayFilter(item)).toBe("other");
    expect(artifactMatchesFilter(item, "all")).toBe(true);
    expect(artifactMatchesFilter(item, "design")).toBe(false);
  });

  test("opens supported sources and leaves missing sources recoverable", () => {
    expect(
      getArtifactDestination(
        artifact({ resourceType: "document", resourceId: "surface-1" }),
        "unassigned",
      ),
    ).toBe("/assistant/documents/surface-1");
    expect(
      getArtifactDestination(
        artifact({ resourceType: "app", resourceId: "app-1", brandId: null }),
        "unassigned",
      ),
    ).toBe("/assistant/work/brands/unassigned/artifacts/apps/app-1");
    expect(getArtifactDestination(artifact({ sourceExists: false }), "brand-1")).toBeUndefined();
  });

  test("describes broken links, containers, and metadata succinctly", () => {
    expect(getArtifactDetail(artifact({ sourceExists: false }))).toBe("Source is unavailable");
    expect(getArtifactDetail(artifact({ childCount: 2 }))).toBe("2 items");
    expect(
      getArtifactDetail(artifact({ metadata: { description: "Approved campaign visual" } })),
    ).toBe("Approved campaign visual");
  });
});
