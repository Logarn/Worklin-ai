import { z } from "zod";

import { client } from "@/generated/api/client.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

const integrationSchema = z.object({
  brandId: z.string().uuid(),
  brandName: z.string(),
  provider: z.string(),
  status: z.string(),
  lastWebhookAt: z.string().datetime().nullable(),
  lastPolledAt: z.string().datetime().nullable(),
  lastReconciledAt: z.string().datetime().nullable(),
  lastErrorCode: z.string().nullable(),
});

const retentionStatusSchema = z.object({
  organizationId: z.string(),
  integrations: z.array(integrationSchema),
  jobs: z.record(z.string(), z.number().int().nonnegative()),
  externalWritesEnabled: z.boolean(),
  sendEnabled: z.boolean(),
});

export type RetentionIntegrationStatus = z.infer<typeof integrationSchema>;

export interface RetentionStatus {
  integrations: RetentionIntegrationStatus[];
  jobs: Record<string, number>;
  externalWritesEnabled: boolean;
  sendEnabled: boolean;
}

/**
 * This endpoint is not in the generated platform specification yet. The
 * singleton client supplies session and workspace authentication; the selected
 * assistant remains explicit because the control plane verifies its ownership.
 */
export async function fetchRetentionStatus(
  assistantId: string,
  brandId?: string | null,
): Promise<RetentionStatus> {
  const { data, error, response } = await client.get<unknown, unknown>({
    url: "/v1/retention/status",
    query: brandId === null || brandId === undefined ? {} : { brandId },
    headers: { "X-Worklin-Assistant-Id": assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load retention status.");
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load retention status."),
    );
  }

  const parsed = retentionStatusSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("Retention status response was invalid.");
  }

  return {
    integrations: parsed.data.integrations,
    jobs: parsed.data.jobs,
    externalWritesEnabled: parsed.data.externalWritesEnabled,
    sendEnabled: parsed.data.sendEnabled,
  };
}
