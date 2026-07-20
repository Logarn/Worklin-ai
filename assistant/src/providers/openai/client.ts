import { getProviderDefaultModel } from "../model-intents.js";
import {
  OpenAIChatCompletionsProvider,
  type OpenAIChatCompletionsProviderOptions,
} from "./chat-completions-provider.js";
import {
  OpenAIResponsesProvider,
  type OpenAIResponsesProviderOptions,
} from "./responses-provider.js";
import { validateOpenAICompatibleApiKey } from "./validate-api-key.js";

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
 * Validate an OpenAI API key with a minimal request to the Responses API.
 * Returns `{ valid: true }` on success or `{ valid: false, reason: string }` on failure.
 */
export async function validateOpenAIApiKey(
  apiKey: string,
): Promise<{ valid: true } | { valid: false; reason: string }> {
  return validateOpenAICompatibleApiKey(apiKey, {
    baseUrl: "https://api.openai.com/v1",
    providerLabel: "OpenAI",
    method: "POST",
    path: "responses",
    body: {
      model: getProviderDefaultModel("openai"),
      input: "Reply with OK.",
      max_output_tokens: 16,
    },
  });
}
