import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { captureError } from "@/lib/sentry/capture-error";

import {
  approveRetentionCampaign,
  fetchRetentionCampaignApprovalPreview,
  fetchRetentionCampaignPreview,
  fetchRetentionCampaigns,
  releaseRetentionCampaign,
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

function reportUnexpectedMutationError(
  error: unknown,
  context: string,
): void {
  if (error instanceof RetentionApiError && error.status < 500) {
    return;
  }
  captureError(error, { context });
}

export function useRetentionCampaigns(
  assistantId: string,
  brandId: string | null = null,
) {
  const isOrgReady = useIsOrgReady();

  return useQuery({
    queryKey: ["retention", "campaigns", assistantId, brandId],
    queryFn: () => fetchRetentionCampaigns(assistantId, brandId!),
    enabled: isOrgReady && Boolean(brandId),
    staleTime: 15_000,
    retry: shouldRetry,
  });
}

export function useRetentionCampaignReview(
  assistantId: string,
  campaignId: string | null,
  brandId: string | null = null,
) {
  const isOrgReady = useIsOrgReady();
  const selectedCampaignId = campaignId ?? "";
  const enabled = isOrgReady && Boolean(brandId) && selectedCampaignId.length > 0;

  const preview = useQuery({
    queryKey: [
      "retention",
      "campaigns",
      assistantId,
      brandId,
      selectedCampaignId,
      "preview",
    ],
    queryFn: () =>
      fetchRetentionCampaignPreview(assistantId, selectedCampaignId),
    enabled,
    staleTime: 10_000,
    retry: shouldRetry,
  });
  const approvalPreview = useQuery({
    queryKey: [
      "retention",
      "campaigns",
      assistantId,
      brandId,
      selectedCampaignId,
      "approval-preview",
    ],
    queryFn: () =>
      fetchRetentionCampaignApprovalPreview(
        assistantId,
        selectedCampaignId,
        brandId!,
      ),
    enabled,
    staleTime: 10_000,
    retry: shouldRetry,
  });

  return { preview, approvalPreview };
}

export function useApproveRetentionCampaign(
  assistantId: string,
  brandId: string | null,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      campaignId,
      expectedSnapshotSha256,
    }: {
      campaignId: string;
      expectedSnapshotSha256: string;
    }) =>
      approveRetentionCampaign(
        assistantId,
        campaignId,
        brandId!,
        expectedSnapshotSha256,
      ),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["retention", "campaigns", assistantId, brandId],
        }),
        queryClient.invalidateQueries({
          queryKey: [
            "retention",
            "campaigns",
            assistantId,
            brandId,
            variables.campaignId,
          ],
        }),
      ]);
    },
    onError: (error) =>
      reportUnexpectedMutationError(error, "retention_campaign_approval"),
  });
}

export function useReleaseRetentionCampaign(
  assistantId: string,
  brandId: string | null,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      campaignId,
      snapshotSha256,
      idempotencyKey,
    }: {
      campaignId: string;
      snapshotSha256: string;
      idempotencyKey: string;
    }) =>
      releaseRetentionCampaign(
        assistantId,
        campaignId,
        brandId!,
        snapshotSha256,
        idempotencyKey,
      ),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["retention", "campaigns", assistantId, brandId],
        }),
        queryClient.invalidateQueries({
          queryKey: [
            "retention",
            "campaigns",
            assistantId,
            brandId,
            variables.campaignId,
          ],
        }),
        queryClient.invalidateQueries({
          queryKey: ["retention", "status", assistantId, brandId],
        }),
      ]);
    },
    onError: (error) =>
      reportUnexpectedMutationError(error, "retention_campaign_release"),
  });
}
