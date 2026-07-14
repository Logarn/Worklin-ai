import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  appsGetOptions,
  artifactsGetOptions,
  brandsGetOptions,
  copybooksByIdGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  ArtifactsGetResponse,
  CopybooksByIdGetResponse,
} from "@/generated/daemon/types.gen";

export const UNASSIGNED_BRAND_ID = "unassigned";

export interface WorkBrandSummary {
  id: string;
  name: string;
  copybookCount: number;
  artifactCount: number;
}

export type ArtifactSummary = ArtifactsGetResponse["artifacts"][number];

function metadataNumber(
  artifact: ArtifactSummary,
  key: string,
  fallback = 0,
): number {
  const value = artifact.metadata?.[key];
  return typeof value === "number" ? value : fallback;
}

function metadataString(artifact: ArtifactSummary, key: string): string {
  const value = artifact.metadata?.[key];
  return typeof value === "string" ? value : "";
}

/** Loads the unified artifact index plus file-backed apps that are not yet registered. */
export function useWorkData(assistantId: string) {
  const brandsQuery = useQuery(
    brandsGetOptions({ path: { assistant_id: assistantId } }),
  );
  const artifactsQuery = useQuery(
    artifactsGetOptions({
      path: { assistant_id: assistantId },
      query: { status: "active" },
    }),
  );
  const appsQuery = useQuery({
    ...appsGetOptions({ path: { assistant_id: assistantId } }),
    select: (data) => data.apps,
  });

  const artifacts = useMemo(
    () => artifactsQuery.data?.artifacts ?? [],
    [artifactsQuery.data?.artifacts],
  );
  const copybookArtifacts = useMemo(
    () =>
      artifacts.filter(
        (artifact) =>
          artifact.resourceType === "copybook" && artifact.sourceExists,
      ),
    [artifacts],
  );
  const detailQueries = useQueries({
    queries: copybookArtifacts.map((artifact) =>
      copybooksByIdGetOptions({
        path: { assistant_id: assistantId, id: artifact.resourceId },
      }),
    ),
  });
  const copybookDetails = useMemo(
    () =>
      detailQueries
        .map((query) => query.data as CopybooksByIdGetResponse | undefined)
        .filter(
          (detail): detail is CopybooksByIdGetResponse => detail !== undefined,
        ),
    [detailQueries],
  );

  const apps = appsQuery.data ?? [];
  const brands = useMemo<WorkBrandSummary[]>(() => {
    const apiBrands = (brandsQuery.data?.brands ?? []).map((brand) => ({
      ...brand,
      copybookCount: copybookArtifacts.filter(
        (artifact) => artifact.brandId === brand.id,
      ).length,
    }));
    const unassignedCount =
      (brandsQuery.data?.unassignedArtifactCount ?? 0) + apps.length;
    if (unassignedCount > 0) {
      apiBrands.push({
        id: UNASSIGNED_BRAND_ID,
        name: "Unassigned",
        copybookCount: 0,
        artifactCount: unassignedCount,
        updatedAt: 0,
      });
    }
    return apiBrands;
  }, [apps.length, brandsQuery.data, copybookArtifacts]);

  const documents = useMemo(
    () =>
      artifacts
        .filter(
          (artifact) =>
            artifact.resourceType === "document" && artifact.sourceExists,
        )
        .map((artifact) => ({
          surfaceId: artifact.resourceId,
          conversationId: metadataString(artifact, "conversationId"),
          title: artifact.title,
          wordCount: metadataNumber(artifact, "wordCount"),
          createdAt: artifact.createdAt,
          updatedAt: artifact.updatedAt,
          brandId: artifact.brandId,
        })),
    [artifacts],
  );

  return {
    apps,
    artifacts,
    brands,
    copybookDetails,
    documents,
    isLoading:
      brandsQuery.isPending ||
      artifactsQuery.isPending ||
      appsQuery.isPending ||
      detailQueries.some((query) => query.isPending),
    hasPartialError:
      brandsQuery.isError ||
      artifactsQuery.isError ||
      appsQuery.isError ||
      detailQueries.some((query) => query.isError),
  };
}
