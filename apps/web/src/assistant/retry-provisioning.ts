import { assistantsProvisioningRetryDetailCreate } from "@/generated/api/sdk.gen";
import { assertHasResponse, toErrorObject } from "@/utils/api-errors";

export type ProvisioningRetryResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; error: Record<string, unknown> };

export async function retryAssistantProvisioning(
  assistantId: string,
): Promise<ProvisioningRetryResult> {
  const { data, error, response } =
    await assistantsProvisioningRetryDetailCreate({
      path: { id: assistantId },
      throwOnError: false,
    });

  assertHasResponse(response, error, "Failed to prepare assistant runtime.");
  if (response.ok) {
    const body =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
    return { ok: true, data: body };
  }

  return {
    ok: false,
    status: response.status,
    error: toErrorObject(error, response),
  };
}
