import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useIsOrgReady } from "@/hooks/use-is-org-ready";

import {
  fetchRetentionImports,
  fetchRetentionSegmentRun,
  fetchRetentionSegments,
  RetentionApiError,
  startRetentionSegmentRun,
  type RetentionSegmentRun,
} from "./retention-api";

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (
    error instanceof RetentionApiError &&
    [403, 404, 409].includes(error.status)
  ) {
    return false;
  }
  return failureCount < 2;
}

export function useRetentionAudiences(assistantId: string) {
  const isOrgReady = useIsOrgReady();
  const imports = useQuery({
    queryKey: ["retention", "imports", assistantId],
    queryFn: () => fetchRetentionImports(assistantId),
    enabled: isOrgReady,
    staleTime: 15_000,
    retry: shouldRetry,
  });
  const brandId = imports.data
    ?.filter((item) => item.provider === "klaviyo")
    .sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )[0]?.brandId;
  const segments = useQuery({
    queryKey: ["retention", "segments", assistantId, brandId],
    queryFn: () => fetchRetentionSegments(assistantId, brandId!),
    enabled: isOrgReady && Boolean(brandId),
    staleTime: 15_000,
    retry: shouldRetry,
  });

  return { brandId: brandId ?? null, imports, segments };
}

export function useRetentionSegmentRun(
  assistantId: string,
  runId: string | null,
) {
  const isOrgReady = useIsOrgReady();
  return useQuery({
    queryKey: ["retention", "segment-runs", assistantId, runId],
    queryFn: () => fetchRetentionSegmentRun(assistantId, runId!),
    enabled: isOrgReady && Boolean(runId),
    staleTime: 1_000,
    retry: shouldRetry,
    refetchInterval: (query) => {
      const run = query.state.data as RetentionSegmentRun | undefined;
      return run?.status === "queued" || run?.status === "claimed"
        ? 2_500
        : false;
    },
  });
}

export function useStartRetentionSegmentRun(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      brandId: string;
      maxSegments: number;
      sampleLimitPerSegment: number;
    }) => startRetentionSegmentRun(assistantId, input),
    onSuccess: async (run) => {
      queryClient.setQueryData(
        ["retention", "segment-runs", assistantId, run.id],
        run,
      );
      await queryClient.invalidateQueries({
        queryKey: ["retention", "segments", assistantId, run.brandId],
      });
    },
  });
}
