import type { TenantExecutionContext } from "@vellumai/service-contracts/tenant-context";

import { runWithConcurrentManagedProviderContext } from "../providers/platform-proxy/concurrent-request-context.js";
import {
  extractAllText,
  getConfiguredProvider,
} from "../providers/provider-send-message.js";
import type { Message, ProviderEvent } from "../providers/types.js";
import type { ConcurrentMessage } from "./types.js";

export interface ConcurrentTurnCallbacks {
  onTextDelta(text: string): Promise<void>;
}

export interface ConcurrentTurnExecutor {
  execute(input: {
    context: TenantExecutionContext;
    messages: readonly ConcurrentMessage[];
    signal: AbortSignal;
    callbacks: ConcurrentTurnCallbacks;
  }): Promise<string>;
}

export interface ConfiguredProviderTurnExecutorOptions {
  systemPrompt: string;
}

function providerMessages(messages: readonly ConcurrentMessage[]): Message[] {
  return messages.map((message) => ({
    role: message.role,
    content: [{ type: "text", text: message.content }],
  }));
}

export class ConfiguredProviderTurnExecutor implements ConcurrentTurnExecutor {
  constructor(
    private readonly options: ConfiguredProviderTurnExecutorOptions,
  ) {}

  async execute(input: {
    context: TenantExecutionContext;
    messages: readonly ConcurrentMessage[];
    signal: AbortSignal;
    callbacks: ConcurrentTurnCallbacks;
  }): Promise<string> {
    return runWithConcurrentManagedProviderContext(input.context, async () => {
      const provider = await getConfiguredProvider("mainAgent", {
        selectionSeed: input.context.conversationId,
      });
      if (!provider) {
        throw new Error("No configured LLM provider is available.");
      }

      let callbackChain = Promise.resolve();
      const onEvent = (event: ProviderEvent) => {
        if (event.type !== "text_delta" || !event.text) return;
        callbackChain = callbackChain.then(() =>
          input.callbacks.onTextDelta(event.text),
        );
      };
      const response = await provider.sendMessage(
        providerMessages(input.messages),
        {
          systemPrompt: this.options.systemPrompt,
          signal: input.signal,
          onEvent,
          config: {
            callSite: "mainAgent",
            selectionSeed: input.context.conversationId,
            usageTracking: "manual",
            usageAttributionHeaders: {
              "X-Worklin-Organization-Id": input.context.organizationId,
              "X-Worklin-Assistant-Id": input.context.assistantId,
              "X-Worklin-User-Id": input.context.userId,
              "X-Worklin-Request-Id": input.context.requestId,
            },
          },
        },
      );
      await callbackChain;
      return extractAllText(response);
    });
  }
}
