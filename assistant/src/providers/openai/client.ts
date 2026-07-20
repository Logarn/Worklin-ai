import {
  OpenAIChatCompletionsProvider,
  type OpenAIChatCompletionsProviderOptions,
} from "./chat-completions-provider.js";
import {
  OpenAIResponsesProvider,
  type OpenAIResponsesProviderOptions,
} from "./responses-provider.js";
import {
  type ApiKeyValidationResult,
  validateOpenAICompatibleApiKey,
  type ValidationFetch,
} from "./validate-api-key.js";

// Re-export the canonical names so callers that know about the new transport
// class can import directly from `openai/client.js`.
export {
  OpenAIChatCompletionsProvider,
  type OpenAIChatCompletionsProviderOptions,
  OpenAIResponsesProvider,
  type OpenAIResponsesProviderOptions,
};

// Backward-compatible aliases: existing code that references `OpenAIProvider`
// or `OpenAICompatibleProviderOptions` from this module keeps compiling
// without any import changes.
export {
  type OpenAIChatCompletionsProviderOptions as OpenAICompatibleProviderOptions,
  OpenAIChatCompletionsProvider as OpenAIProvider,
};

/**
 * Validate an OpenAI API key without requiring access to a specific model.
 */
export async function validateOpenAIApiKey(
  apiKey: string,
  fetchImpl?: ValidationFetch,
): Promise<ApiKeyValidationResult> {
  return validateOpenAICompatibleApiKey(apiKey, {
    baseUrl: "https://api.openai.com/v1",
    providerLabel: "OpenAI",
    fetchImpl,
    rejectionStatuses: [401],
  });
}
