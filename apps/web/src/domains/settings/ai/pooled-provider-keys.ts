import {
  isPooledApiKeyProvider,
  type PooledApiKeyProvider,
} from "@/assistant/pooled-model-provider";
import { secretsDelete, secretsPost } from "@/generated/daemon/sdk.gen";

export class PooledProviderKeyError extends Error {
  readonly status: number;

  constructor(
    readonly code:
      | "pooled_provider_api_key_required"
      | "pooled_provider_delete_failed"
      | "pooled_provider_save_failed"
      | "pooled_provider_unsupported",
    message: string,
    status = 400,
  ) {
    super(message);
    this.name = "PooledProviderKeyError";
    this.status = status;
  }
}

export async function savePooledProviderKey(input: {
  assistantId: string;
  provider: string;
  value: string;
}): Promise<PooledApiKeyProvider> {
  if (!isPooledApiKeyProvider(input.provider)) {
    throw new PooledProviderKeyError(
      "pooled_provider_unsupported",
      "This provider needs a dedicated assistant runtime and was not saved.",
      409,
    );
  }
  const value = input.value.trim();
  if (!value) {
    throw new PooledProviderKeyError(
      "pooled_provider_api_key_required",
      "Enter an API key before saving.",
    );
  }
  const { response } = await secretsPost({
    path: { assistant_id: input.assistantId },
    body: { type: "api_key", name: input.provider, value },
    throwOnError: false,
  });
  if (!response?.ok) {
    throw new PooledProviderKeyError(
      "pooled_provider_save_failed",
      response?.status === 409
        ? "A pooled assistant can use one model provider at a time. Remove the current key before choosing another provider."
        : "Worklin could not save this API key. Please try again.",
      response?.status ?? 500,
    );
  }
  return input.provider;
}

export async function deletePooledProviderKey(input: {
  assistantId: string;
  provider: string;
}): Promise<void> {
  if (!isPooledApiKeyProvider(input.provider)) {
    throw new PooledProviderKeyError(
      "pooled_provider_unsupported",
      "This provider is not supported by the pooled credential vault.",
      409,
    );
  }
  const { response } = await secretsDelete({
    path: { assistant_id: input.assistantId },
    body: { type: "api_key", name: input.provider },
    throwOnError: false,
  });
  if (!response?.ok && response?.status !== 404) {
    throw new PooledProviderKeyError(
      "pooled_provider_delete_failed",
      "Worklin could not remove this API key. Please try again.",
      response?.status ?? 500,
    );
  }
}
