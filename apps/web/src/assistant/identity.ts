/**
 * Runtime identity for the assistant: name, role, personality, emoji,
 * home, version, and (optionally) creation timestamp.
 *
 * Fetched from the daemon through the wildcard proxy. Returns `null`
 * when the identity cannot be retrieved (the assistant is still
 * initializing, the runtime is unreachable, etc.) so the caller can
 * fall back to a stub.
 */
import { identityGet, identityPatch } from "@/generated/daemon/sdk.gen";
import type {
  IdentityGetResponse,
  IdentityPatchData,
} from "@/generated/daemon/types.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

export type AssistantIdentityUpdate = IdentityPatchData["body"];

export async function fetchAssistantIdentity(
  assistantId: string,
): Promise<IdentityGetResponse | null> {
  try {
    const { data, error, response } = await identityGet({
      path: { assistant_id: assistantId },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch assistant identity");

    if (!response.ok || !data || typeof data !== "object") {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

export async function updateAssistantIdentity(
  assistantId: string,
  update: AssistantIdentityUpdate,
): Promise<IdentityGetResponse> {
  const { data, error, response } = await identityPatch({
    path: { assistant_id: assistantId },
    body: update,
    throwOnError: false,
  });

  assertHasResponse(response, error, "Failed to save assistant identity");
  if (!response.ok || !data) {
    throw new ApiError(
      response.status,
      extractErrorMessage(
        error,
        response,
        "Could not save the assistant identity.",
      ),
    );
  }

  for (const [field, value] of Object.entries(update)) {
    if (data[field as keyof AssistantIdentityUpdate] !== value) {
      throw new ApiError(
        response.status,
        "The assistant identity could not be verified after saving.",
      );
    }
  }

  return data;
}
