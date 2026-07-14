import type { ArtifactsGetResponse } from "@/generated/daemon/types.gen";
import { routes } from "@/utils/routes";

export type RegistryArtifact = ArtifactsGetResponse["artifacts"][number];

export type ArtifactDisplayFilter =
  | "all"
  | "copy"
  | "design"
  | "images"
  | "video"
  | "social"
  | "apps"
  | "documents";

const TYPE_KEYWORDS: Record<Exclude<ArtifactDisplayFilter, "all">, string[]> = {
  copy: ["copy", "copybook", "email", "sms", "campaign", "brief"],
  design: ["design", "creative", "layout"],
  images: ["image", "photo", "product_image"],
  video: ["video", "reel", "motion"],
  social: ["social", "facebook", "instagram", "linkedin", "post"],
  apps: ["app", "application"],
  documents: ["document", "doc"],
};

/** Maps open-ended registry classifications into the stable UI filters. */
export function getArtifactDisplayFilter(
  artifact: RegistryArtifact,
): Exclude<ArtifactDisplayFilter, "all"> | "other" {
  const values = [artifact.artifactType, artifact.resourceType].map((value) =>
    value.toLowerCase(),
  );
  for (const [filter, keywords] of Object.entries(TYPE_KEYWORDS)) {
    if (
      values.some((value) =>
        keywords.some(
          (keyword) => value === keyword || value.includes(`${keyword}_`),
        ),
      )
    ) {
      return filter as Exclude<ArtifactDisplayFilter, "all">;
    }
  }
  return "other";
}

export function artifactMatchesFilter(
  artifact: RegistryArtifact,
  filter: ArtifactDisplayFilter,
): boolean {
  return filter === "all" || getArtifactDisplayFilter(artifact) === filter;
}

/** Returns a canonical open destination when the source has a supported viewer. */
export function getArtifactDestination(
  artifact: RegistryArtifact,
  fallbackBrandId: string,
): string | undefined {
  if (!artifact.sourceExists) return undefined;
  if (artifact.resourceType === "document") {
    return routes.document(artifact.resourceId);
  }
  if (artifact.resourceType === "app") {
    return routes.work.app(artifact.brandId ?? fallbackBrandId, artifact.resourceId);
  }
  return undefined;
}

export function getArtifactDetail(artifact: RegistryArtifact): string {
  if (!artifact.sourceExists) return "Source is unavailable";
  const description = artifact.metadata?.description;
  if (typeof description === "string" && description.trim()) return description;
  if (artifact.childCount > 0) {
    return `${artifact.childCount} ${artifact.childCount === 1 ? "item" : "items"}`;
  }
  return artifact.artifactType.replaceAll("_", " ");
}
