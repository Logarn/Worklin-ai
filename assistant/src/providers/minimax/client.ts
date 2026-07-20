import OpenAI from "openai";

import { getLogger } from "../../util/logger.js";
import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";

const log = getLogger("minimax-client");

/** Validation-specific timeout (10s) so a stalled network doesn't block key submission. */
const VALIDATION_TIMEOUT_MS = 10_000;

export interface MinimaxProviderOptions {
  apiKey?: string;
  baseURL?: string;
  streamTimeoutMs?: number;
}

const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1";

/** Validate a MiniMax API key against the endpoint used by the runtime. */
export async function validateMinimaxApiKey(
  apiKey: string,
): Promise<{ valid: true } | { valid: false; reason: string }> {
  return tryValidate(apiKey, DEFAULT_MINIMAX_BASE_URL);
}

async function tryValidate(
  apiKey: string,
  baseURL: string,
): Promise<{ valid: true } | { valid: false; reason: string }> {
  try {
    const client = new OpenAI({
      apiKey,
      baseURL,
      timeout: VALIDATION_TIMEOUT_MS,
      maxRetries: 0,
    });
    await client.models.list();
    return { valid: true };
  } catch (error) {
    if (error instanceof OpenAI.APIError) {
      if (error.status === 401) {
        return { valid: false, reason: "API key is invalid or expired." };
      }
      if (error.status === 403) {
        return {
          valid: false,
          reason: `MiniMax API error (${error.status}): ${error.message}`,
        };
      }
      log.warn(
        { status: error.status, baseURL },
        "MiniMax API key validation could not complete",
      );
      return {
        valid: false,
        reason: `MiniMax could not verify this connection (${error.status}). Try again shortly.`,
      };
    }
    log.warn(
      {
        error: error instanceof Error ? error.message : String(error),
        baseURL,
      },
      "MiniMax API key validation request failed",
    );
    return {
      valid: false,
      reason:
        "MiniMax could not verify this connection. Check your network and try again.",
    };
  }
}

export class MinimaxProvider extends OpenAIChatCompletionsProvider {
  constructor(
    apiKey: string,
    model: string,
    options: MinimaxProviderOptions = {},
  ) {
    const baseURL = options.baseURL?.trim() || DEFAULT_MINIMAX_BASE_URL;
    super(apiKey, model, {
      baseURL,
      providerName: "minimax",
      providerLabel: "MiniMax",
      streamTimeoutMs: options.streamTimeoutMs,
      // Without reasoning_split, MiniMax embeds reasoning in `content`
      // wrapped in <think>...</think> tags (and also mirrors it into
      // reasoning deltas), so raw tags leak into user-visible text. With it,
      // reasoning arrives only via `reasoning_content`/`reasoning_details`,
      // which the base provider already parses into thinking blocks.
      extraCreateParams: { reasoning_split: true },
      // MiniMax models reason between tool calls (interleaved thinking) and
      // expect prior-turn reasoning replayed on multi-turn requests.
      assistantReasoningField: "reasoning_content",
    });
  }
}
