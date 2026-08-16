import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useIsOrgReady } from "@/hooks/use-is-org-ready";

import {
  activateRetentionProgram,
  approveRetentionImport,
  fetchRetentionImports,
  fetchRetentionProgramApprovalPreview,
  fetchRetentionPrograms,
  pauseRetentionProgram,
  RetentionApiError,
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

export function useRetentionSetup(
  assistantId: string,
  brandId: string | null = null,
) {
  const isOrgReady = useIsOrgReady();
  const programs = useQuery({
    queryKey: ["retention", "programs", assistantId, brandId],
    queryFn: () => fetchRetentionPrograms(assistantId, brandId!),
    enabled: isOrgReady && Boolean(brandId),
    staleTime: 15_000,
    retry: shouldRetry,
  });
  const imports = useQuery({
    queryKey: ["retention", "imports", assistantId, brandId],
    queryFn: () => fetchRetentionImports(assistantId, brandId!),
    enabled: isOrgReady && Boolean(brandId),
    staleTime: 15_000,
    retry: shouldRetry,
  });
  return { programs, imports };
}

export function useRetentionProgramApprovalPreview(
  assistantId: string,
  programId: string | null,
  brandId: string | null = null,
) {
  const isOrgReady = useIsOrgReady();
  return useQuery({
    queryKey: [
      "retention",
      "programs",
      assistantId,
      brandId,
      programId,
      "approval-preview",
    ],
    queryFn: () =>
      fetchRetentionProgramApprovalPreview(assistantId, programId!, brandId!),
    enabled: isOrgReady && Boolean(programId) && Boolean(brandId),
    staleTime: 10_000,
    retry: shouldRetry,
  });
}

export function useActivateRetentionProgram(
  assistantId: string,
  brandId: string | null,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { programId: string; expectedPolicySha256: string }) =>
      activateRetentionProgram(
        assistantId,
        input.programId,
        brandId!,
        input.expectedPolicySha256,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["retention", "programs", assistantId, brandId],
      }),
  });
}

export function usePauseRetentionProgram(
  assistantId: string,
  brandId: string | null,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { programId: string; reason: string }) =>
      pauseRetentionProgram(
        assistantId,
        input.programId,
        brandId!,
        input.reason,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["retention", "programs", assistantId, brandId],
      }),
  });
}

export function useApproveRetentionImport(
  assistantId: string,
  brandId: string | null,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (migrationRunId: string) =>
      approveRetentionImport(assistantId, migrationRunId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["retention", "imports", assistantId, brandId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["retention", "status", assistantId, brandId],
        }),
      ]);
    },
  });
}
