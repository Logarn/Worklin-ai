import {
  assistantsAccessConsentDetailPartialUpdate,
  assistantsAccessConsentDetailRead,
} from "@/generated/api/sdk.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

export interface AssistantAccessConsent {
  access_consented: boolean;
  can_update: boolean;
}

function normalizeAccessConsent(
  value: unknown,
  response: Response,
): AssistantAccessConsent {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { access_consented?: unknown }).access_consented !==
      "boolean" ||
    typeof (value as { can_update?: unknown }).can_update !== "boolean"
  ) {
    throw new ApiError(
      response.status,
      "The assistant returned an invalid admin access setting.",
    );
  }
  return value as AssistantAccessConsent;
}

export async function getAssistantAccessConsent(
  assistantId: string,
): Promise<AssistantAccessConsent> {
  const { data, error, response } = await assistantsAccessConsentDetailRead({
    path: { id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(
    response,
    error,
    "Could not load the admin access setting.",
  );
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(
        error,
        response,
        "Could not load the admin access setting.",
      ),
    );
  }
  return normalizeAccessConsent(data, response);
}

export async function updateAssistantAccessConsent(
  assistantId: string,
  accessConsented: boolean,
): Promise<AssistantAccessConsent> {
  const { data, error, response } =
    await assistantsAccessConsentDetailPartialUpdate({
      path: { id: assistantId },
      body: { access_consented: accessConsented },
      keepalive: true,
      throwOnError: false,
    });
  assertHasResponse(
    response,
    error,
    "Could not update the admin access setting.",
  );
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractErrorMessage(
        error,
        response,
        "Could not update the admin access setting.",
      ),
    );
  }
  return normalizeAccessConsent(data, response);
}
