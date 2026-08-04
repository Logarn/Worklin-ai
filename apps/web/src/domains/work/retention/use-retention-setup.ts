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

export function useRetentionSetup(assistantId: string) {
  const isOrgReady = useIsOrgReady();
  const programs = useQuery({
    queryKey: ["retention", "programs", assistantId],
    queryFn: () => fetchRetentionPrograms(assistantId),
    enabled: isOrgReady,
    staleTime: 15_000,
    retry: shouldRetry,
  });
  const imports = useQuery({
    queryKey: ["retention", "imports", assistantId],
    queryFn: () => fetchRetentionImports(assistantId),
    enabled: isOrgReady,
    staleTime: 15_000,
    retry: shouldRetry,
  });
  return { programs, imports };
}

export function useRetentionProgramApprovalPreview(
  assistantId: string,
  programId: string | null,
) {
  const isOrgReady = useIsOrgReady();
  return useQuery({
    queryKey: [
      "retention",
      "programs",
      assistantId,
      programId,
      "approval-preview",
    ],
    queryFn: () =>
      fetchRetentionProgramApprovalPreview(assistantId, programId!),
    enabled: isOrgReady && Boolean(programId),
    staleTime: 10_000,
    retry: shouldRetry,
  });
}

export function useActivateRetentionProgram(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { programId: string; expectedPolicySha256: string }) =>
      activateRetentionProgram(
        assistantId,
        input.programId,
        input.expectedPolicySha256,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["retention", "programs", assistantId],
      }),
  });
}

export function usePauseRetentionProgram(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { programId: string; reason: string }) =>
      pauseRetentionProgram(assistantId, input.programId, input.reason),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["retention", "programs", assistantId],
      }),
  });
}

export function useApproveRetentionImport(assistantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (migrationRunId: string) =>
      approveRetentionImport(assistantId, migrationRunId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["retention", "imports", assistantId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["retention", "status", assistantId],
        }),
      ]);
    },
  });
}
