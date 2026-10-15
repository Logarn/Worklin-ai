import {
  type BrowserBrokerOperation,
  BrowserBrokerOperationSchema,
} from "@vellumai/service-contracts/browser-broker";
import type { TenantExecutionContext } from "@vellumai/service-contracts/tenant-context";
import { z } from "zod";

import type { ConcurrentProviderRequestConfig } from "../providers/platform-proxy/concurrent-request-context.js";
import { runWithConcurrentManagedProviderContext } from "../providers/platform-proxy/concurrent-request-context.js";
import {
  extractAllText,
  getConfiguredProvider,
} from "../providers/provider-send-message.js";
import type {
  ContentBlock,
  Message,
  ProviderEvent,
  ToolDefinition,
  ToolUseContent,
} from "../providers/types.js";
import type { ConcurrentOnboardingContext } from "./onboarding-context.js";
import type { ConcurrentMessage, ConcurrentRunStep } from "./types.js";

export interface ConcurrentTurnCallbacks {
  onTextDelta(text: string): Promise<void>;
}

export interface ConcurrentTurnExecutor {
  execute(input: {
    context: TenantExecutionContext;
    messages: readonly ConcurrentMessage[];
    steps: readonly ConcurrentRunStep[];
    providerConfig?: ConcurrentProviderRequestConfig;
    onboardingContext?: ConcurrentOnboardingContext;
    browserEnabled: boolean;
    signal: AbortSignal;
    callbacks: ConcurrentTurnCallbacks;
  }): Promise<ConcurrentTurnExecution | string>;
}

export type ConcurrentTurnExecution =
  | { kind: "complete"; content: string }
  | {
      kind: "browser_action";
      toolUseId: string;
      operation: BrowserBrokerOperation;
      providerContent: ContentBlock[];
      executionConfig: Record<string, unknown>;
    };

export interface ConfiguredProviderTurnExecutorOptions {
  systemPrompt: string;
}

export function buildConcurrentProviderMessages(
  messages: readonly ConcurrentMessage[],
  steps: readonly ConcurrentRunStep[],
  onboardingContext?: ConcurrentOnboardingContext,
): Message[] {
  const history: Message[] = messages.map((message) => ({
    role: message.role,
    content: [{ type: "text", text: message.content }],
  }));
  for (const step of steps) {
    if (!Array.isArray(step.providerContent)) {
      throw new Error("Persisted concurrent run step content is invalid.");
    }
    history.push({
      role: step.stepKind === "provider_response" ? "assistant" : "user",
      content: structuredClone(step.providerContent) as ContentBlock[],
    });
  }
  if (onboardingContext) {
    const firstUserMessage = history.find((message) => message.role === "user");
    if (firstUserMessage) {
      const preferences = { ...onboardingContext };
      delete preferences.initialMessage;
      firstUserMessage.content.push({
        type: "text",
        text: `Additional onboarding context supplied by the user:\n${JSON.stringify(preferences)}`,
      });
    }
  }
  return history;
}

const browserInputSchema = z.toJSONSchema(BrowserBrokerOperationSchema);
delete browserInputSchema.$schema;

export const CONCURRENT_BROWSER_TOOL: ToolDefinition = {
  name: "browser_control",
  description:
    "Use the user's explicitly connected Chrome tab for bounded browser work. Open a session before interacting. Use snapshot element references for click, type, and selection. Never use it for passwords, one-time codes, payments, files, localhost, private networks, or browser settings.",
  input_schema: browserInputSchema,
};

export class ConfiguredProviderTurnExecutor implements ConcurrentTurnExecutor {
  constructor(
    private readonly options: ConfiguredProviderTurnExecutorOptions,
  ) {}

  async execute(input: {
    context: TenantExecutionContext;
    messages: readonly ConcurrentMessage[];
    steps: readonly ConcurrentRunStep[];
    providerConfig?: ConcurrentProviderRequestConfig;
    onboardingContext?: ConcurrentOnboardingContext;
    browserEnabled: boolean;
    signal: AbortSignal;
    callbacks: ConcurrentTurnCallbacks;
  }): Promise<ConcurrentTurnExecution> {
    const providerConfig = input.providerConfig ?? null;
    return runWithConcurrentManagedProviderContext(
      input.context,
      providerConfig,
      async () => {
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
        let response: Awaited<ReturnType<typeof provider.sendMessage>>;
        try {
          response = await provider.sendMessage(
            buildConcurrentProviderMessages(
              input.messages,
              input.steps,
              input.onboardingContext,
            ),
            {
              tools: input.browserEnabled
                ? [CONCURRENT_BROWSER_TOOL]
                : undefined,
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
        } catch {
          throw new Error("The model provider could not complete the request.");
        }
        await callbackChain;
        const browserCalls = response.content.filter(
          (block): block is ToolUseContent =>
            block.type === "tool_use" && block.name === "browser_control",
        );
        if (browserCalls.length > 1) {
          throw new Error(
            "Concurrent browser turns permit one action per model step.",
          );
        }
        const browserCall = browserCalls[0];
        if (browserCall) {
          const operation = BrowserBrokerOperationSchema.parse(
            browserCall.input,
          );
          return {
            kind: "browser_action",
            toolUseId: browserCall.id,
            operation,
            providerContent: response.content,
            executionConfig: {
              providerModel: response.model,
              ...(response.actualProvider
                ? { actualProvider: response.actualProvider }
                : {}),
              browserToolSchemaVersion: 1,
            },
          };
        }
        return { kind: "complete", content: extractAllText(response) };
      },
    );
  }
}
