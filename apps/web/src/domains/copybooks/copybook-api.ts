import { copybooksByIdGet } from "@/generated/daemon/sdk.gen";
import type { CopybooksByIdGetResponse } from "@/generated/daemon/types.gen";
import { ApiError, assertHasResponse, extractErrorMessage } from "@/utils/api-errors";

export type CopybookDetail = CopybooksByIdGetResponse;
export type CopybookRecord = CopybookDetail["copybook"];
export type CopybookMonth = CopybookDetail["months"][number];
export type CopybookCampaign = CopybookMonth["campaigns"][number];
export type CopybookStrategyStatus = CopybookMonth["strategyStatus"];
export type CopybookCampaignStatus = CopybookCampaign["status"];

export async function fetchCopybook(
  assistantId: string,
  copybookId: string,
): Promise<CopybookDetail> {
  const { data, error, response } = await copybooksByIdGet({
    path: { assistant_id: assistantId, id: copybookId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load copybook.");
  if (!response.ok || !data) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load copybook."),
    );
  }
  return data;
}
