import type { ConnectionProvider } from "@/generated/daemon/types.gen";

import { parseCredentialRef } from "@/domains/settings/ai/provider-editor-constants";

type ApiKeySecretBody =
  | { type: "api_key"; name: string; value: string }
  | { type: "credential"; name: string; value: string };

/**
 * First-class LLM providers should use the daemon's api_key secret route.
 * That route stores the value at credential/<provider>/api_key and keeps
 * provider-key behavior aligned with onboarding.
 */
export function providerApiKeySecretBody(
  provider: ConnectionProvider,
  credentialRef: string,
  value: string,
): ApiKeySecretBody {
  const parsed = parseCredentialRef(credentialRef);

  if (parsed?.field === "api_key" && parsed.service === provider) {
    return { type: "api_key", name: provider, value };
  }

  if (parsed) {
    return {
      type: "credential",
      name: `${parsed.service}:${parsed.field}`,
      value,
    };
  }

  return { type: "api_key", name: provider, value };
}
