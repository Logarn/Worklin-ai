import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";

export interface KimiProviderOptions {
  apiKey?: string;
  baseURL?: string;
  streamTimeoutMs?: number;
}

const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.ai/v1";

export class KimiProvider extends OpenAIChatCompletionsProvider {
  constructor(
    apiKey: string,
    model: string,
    options: KimiProviderOptions = {},
  ) {
    super(apiKey, model, {
      baseURL: options.baseURL?.trim() || DEFAULT_KIMI_BASE_URL,
      providerName: "kimi",
      providerLabel: "Kimi",
      streamTimeoutMs: options.streamTimeoutMs,
      assistantReasoningField: "reasoning_content",
    });
  }
}
