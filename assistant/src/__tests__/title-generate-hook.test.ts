/**
 * Tests for the default `title-generate` plugin's hooks.
 *
 * The plugin contributes two pure-trigger hooks that delegate the title work
 * to the service:
 *
 * - `user-prompt-submit` — first-pass generation from the submitted prompt,
 *   scheduled on a later macrotask so the main agent-loop LLM request is
 *   issued first.
 * - `stop` — second-pass regeneration once the conversation reaches its third
 *   user turn (turn count derived from the user prompts in history).
 *
 * Both let the title service resolve the provider, persist the title, and
 * broadcast the resulting `conversation_title_updated` / `sync_changed`
 * events.
 *
 * Mocks `memory/conversation-title-service.js` and `config/loader.js` so the
 * tests don't touch the real provider stack or config, and resets the plugin
 * registry between cases.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

interface MockTitleConversation {
  conversationType: "standard" | "background" | "scheduled";
  source?: string | null;
  originChannel?: string | null;
}

let mockTitleConversation: MockTitleConversation | null = null;
const getConversationMock = mock(
  (_conversationId: string): MockTitleConversation | null =>
    mockTitleConversation,
);
mock.module("../memory/conversation-crud.js", () => ({
  getConversation: getConversationMock,
  getMessages: mock(() => []),
  updateMessageContent: mock(() => {}),
  updateMessageMetadata: mock(() => {}),
}));

// Stub the title-generation service before importing anything that binds
// to it, so both the default plugin and the hooks capture the stubbed binding.
const queueGenerateConversationTitleMock = mock(
  (_params: {
    conversationId: string;
    provider?: unknown;
    userMessage?: string;
    context?: { origin: string; sourceChannel?: string };
  }): void => undefined,
);
const queueRegenerateConversationTitleMock = mock(
  (_params: {
    conversationId: string;
    provider?: unknown;
    context?: { origin: string; sourceChannel?: string };
  }): void => undefined,
);
const generateConversationTitleRequestBoundMock = mock(
  async (_params: {
    conversationId: string;
    userMessage?: string;
    assistantResponse?: string;
    context?: { origin: string; sourceChannel?: string };
  }): Promise<{ title: string; updated: boolean }> => ({
    title: "First title",
    updated: true,
  }),
);
const regenerateConversationTitleRequestBoundMock = mock(
  async (_params: {
    conversationId: string;
    recentMessages?: ReadonlyArray<{
      role: "user" | "assistant";
      text: string;
    }>;
    context?: { origin: string; sourceChannel?: string };
  }): Promise<{ title: string; updated: boolean }> => ({
    title: "Refined title",
    updated: true,
  }),
);
mock.module("../memory/conversation-title-service.js", () => ({
  generateConversationTitleRequestBound:
    generateConversationTitleRequestBoundMock,
  queueGenerateConversationTitle: queueGenerateConversationTitleMock,
  queueRegenerateConversationTitle: queueRegenerateConversationTitleMock,
  regenerateConversationTitleRequestBound:
    regenerateConversationTitleRequestBoundMock,
}));

let pooledRuntime = false;
mock.module("../config/env.js", () => ({
  isPooledWorkerRuntime: () => pooledRuntime,
}));

// The `stop` hook reads `conversations.skipAutoRetitling`; stub the loader so
// the opt-out is controllable per test.
let skipAutoRetitling = false;
mock.module("../config/loader.js", () => ({
  getConfig: () => ({ conversations: { skipAutoRetitling } }),
}));

import { HOOKS } from "../plugin-api/constants.js";
import type {
  PluginLogger,
  StopContext,
  UserPromptSubmitContext,
} from "../plugin-api/types.js";
import { defaultTitleGeneratePlugin } from "../plugins/defaults/index.js";
import stop from "../plugins/defaults/title-generate/hooks/stop.js";
import userPromptSubmit from "../plugins/defaults/title-generate/hooks/user-prompt-submit.js";
import { runHook } from "../plugins/pipeline.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { Message } from "../providers/types.js";

const noopLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeCtx(
  overrides: Partial<UserPromptSubmitContext> = {},
): UserPromptSubmitContext {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "first message" }] },
  ];
  return {
    conversationId: "conv-1",
    userMessageId: "msg-1",
    requestId: "req-1",
    modelProfileKey: null,
    isNonInteractive: false,
    prompt: "first message",
    originalMessages: messages,
    latestMessages: messages,
    logger: noopLogger,
    ...overrides,
  };
}

/** Flush pending `setTimeout(0)` callbacks so the fire-and-forget trigger runs. */
function flushMacrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function userTurn(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantTurn(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/** A user-role message carrying only tool results, not a fresh prompt. */
function toolResultTurn(): Message {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
  };
}

/** History with `count` genuine user turns interleaved with assistant replies. */
function historyWithUserTurns(count: number): Message[] {
  const messages: Message[] = [];
  for (let i = 1; i <= count; i++) {
    messages.push(userTurn(`message ${i}`));
    messages.push(assistantTurn(`reply ${i}`));
  }
  return messages;
}

function makeStopCtx(overrides: Partial<StopContext> = {}): StopContext {
  return {
    conversationId: "conv-1",
    messages: historyWithUserTurns(3),
    exitReason: "no_tool_calls",
    logger: noopLogger,
    ...overrides,
  };
}

describe("title-generate user-prompt-submit hook", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    mockTitleConversation = null;
    getConversationMock.mockClear();
    getConversationMock.mockImplementation(
      (_conversationId: string) => mockTitleConversation,
    );
    queueGenerateConversationTitleMock.mockReset();
    queueGenerateConversationTitleMock.mockImplementation(() => undefined);
    generateConversationTitleRequestBoundMock.mockReset();
    generateConversationTitleRequestBoundMock.mockResolvedValue({
      title: "First title",
      updated: true,
    });
    pooledRuntime = false;
  });

  test("queues a title-generation job from the submitted prompt", async () => {
    // GIVEN a fresh user prompt submission
    const ctx = makeCtx({ conversationId: "conv-1", prompt: "first message" });

    // WHEN the default hook runs and its deferred work flushes
    await userPromptSubmit(ctx);
    await flushMacrotasks();

    // THEN the title service is invoked with just the conversation id and the
    // submitted prompt — provider resolution and emit are owned by the service.
    expect(queueGenerateConversationTitleMock).toHaveBeenCalledTimes(1);
    const call = queueGenerateConversationTitleMock.mock.calls[0]?.[0];
    expect(call?.conversationId).toBe("conv-1");
    expect(call?.userMessage).toBe("first message");
    expect(call).not.toHaveProperty("provider");
    expect(call).not.toHaveProperty("onTitleUpdated");
  });

  test("does not block: returns before the title job is scheduled", async () => {
    // GIVEN a fresh user prompt submission
    const ctx = makeCtx();

    // WHEN the hook resolves
    await userPromptSubmit(ctx);

    // THEN the title job has not run yet (it is deferred to a later macrotask),
    // AND it runs once the macrotask queue is flushed.
    expect(queueGenerateConversationTitleMock).toHaveBeenCalledTimes(0);
    await flushMacrotasks();
    expect(queueGenerateConversationTitleMock).toHaveBeenCalledTimes(1);
  });

  test("fires through runHook once the default plugin is registered", async () => {
    // GIVEN the default title-generate plugin registered in the registry
    registerPlugin(defaultTitleGeneratePlugin);

    // WHEN a prompt is submitted through the hook chain
    await runHook(
      HOOKS.USER_PROMPT_SUBMIT,
      makeCtx({ prompt: "draft a plan" }),
    );
    await flushMacrotasks();

    // THEN the title service is triggered with the submitted prompt text
    expect(queueGenerateConversationTitleMock).toHaveBeenCalledTimes(1);
    expect(
      queueGenerateConversationTitleMock.mock.calls[0]?.[0]?.userMessage,
    ).toBe("draft a plan");
  });

  test("does not schedule a detached title timer in a pooled worker", async () => {
    // GIVEN the legacy queue would synchronously reject pooled background work
    pooledRuntime = true;
    queueGenerateConversationTitleMock.mockImplementation(() => {
      throw new Error("detached pooled title job");
    });

    // WHEN the prompt hook runs and enough time passes for any timer to escape
    await expect(userPromptSubmit(makeCtx())).resolves.toBeUndefined();
    await flushMacrotasks();

    // THEN no detached title job was scheduled; the stop hook owns this work
    expect(queueGenerateConversationTitleMock).not.toHaveBeenCalled();
  });

  test("passes schedule origin for a noninteractive system row stored as standard", async () => {
    mockTitleConversation = {
      conversationType: "standard",
      source: "schedule",
    };

    await userPromptSubmit(
      makeCtx({
        conversationId: "conv-manual-schedule",
        isNonInteractive: true,
        prompt: "Prepare the launch report",
      }),
    );
    await flushMacrotasks();

    expect(queueGenerateConversationTitleMock).toHaveBeenCalledWith({
      conversationId: "conv-manual-schedule",
      userMessage: "Prepare the launch report",
      context: { origin: "schedule" },
    });
  });

  test("treats remote human channel rows as channel inbound even without an interactive client", async () => {
    const humanChannelRows: MockTitleConversation[] = [
      {
        conversationType: "standard",
        source: "user",
        originChannel: "slack",
      },
      {
        conversationType: "standard",
        source: "slack",
        originChannel: null,
      },
    ];

    for (const [index, conversation] of humanChannelRows.entries()) {
      mockTitleConversation = conversation;
      const conversationId = `conv-human-channel-${index}`;

      await userPromptSubmit(
        makeCtx({
          conversationId,
          isNonInteractive: true,
          prompt: "Summarize this customer thread",
        }),
      );
      await flushMacrotasks();

      expect(queueGenerateConversationTitleMock).toHaveBeenLastCalledWith({
        conversationId,
        userMessage: "Summarize this customer thread",
        context: { origin: "channel_inbound", sourceChannel: "slack" },
      });
    }

    expect(queueGenerateConversationTitleMock).toHaveBeenCalledTimes(2);
  });

  test("honors explicit stored channels ahead of the default user source", async () => {
    const cases = [
      { channel: "a2a", expectedOrigin: "misc" },
      { channel: "platform", expectedOrigin: "runtime_api" },
      { channel: "custom-agent", expectedOrigin: "misc" },
    ];

    for (const { channel, expectedOrigin } of cases) {
      mockTitleConversation = {
        conversationType: "standard",
        source: "user",
        originChannel: channel,
      };
      const conversationId = `conv-${channel}`;

      await userPromptSubmit(
        makeCtx({
          conversationId,
          isNonInteractive: true,
          prompt: "Process this assistant request",
        }),
      );
      await flushMacrotasks();

      expect(queueGenerateConversationTitleMock).toHaveBeenLastCalledWith({
        conversationId,
        userMessage: "Process this assistant request",
        context: { origin: expectedOrigin, sourceChannel: channel },
      });
    }
  });

  test("lets the service re-read first-turn provenance after a transient lookup failure", async () => {
    getConversationMock.mockImplementationOnce(() => {
      throw new Error("database temporarily unavailable");
    });

    await userPromptSubmit(
      makeCtx({
        conversationId: "conv-transient-first-turn",
        isNonInteractive: true,
        prompt: "Summarize the launch status",
      }),
    );
    await flushMacrotasks();

    expect(queueGenerateConversationTitleMock).toHaveBeenCalledWith({
      conversationId: "conv-transient-first-turn",
      userMessage: "Summarize the launch status",
    });
  });
});

describe("title-generate stop hook", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    mockTitleConversation = null;
    getConversationMock.mockClear();
    getConversationMock.mockImplementation(
      (_conversationId: string) => mockTitleConversation,
    );
    queueGenerateConversationTitleMock.mockReset();
    queueGenerateConversationTitleMock.mockImplementation(() => undefined);
    queueRegenerateConversationTitleMock.mockReset();
    queueRegenerateConversationTitleMock.mockImplementation(() => undefined);
    generateConversationTitleRequestBoundMock.mockReset();
    generateConversationTitleRequestBoundMock.mockResolvedValue({
      title: "First title",
      updated: true,
    });
    regenerateConversationTitleRequestBoundMock.mockReset();
    regenerateConversationTitleRequestBoundMock.mockResolvedValue({
      title: "Refined title",
      updated: true,
    });
    skipAutoRetitling = false;
    pooledRuntime = false;
  });

  test("regenerates the title on the third user turn", async () => {
    // GIVEN a turn ending with three genuine user prompts in history
    const ctx = makeStopCtx({ messages: historyWithUserTurns(3) });

    // WHEN the stop hook runs and its deferred work flushes
    await stop(ctx);
    await flushMacrotasks();

    // THEN the second-pass regeneration is triggered with just the
    // conversation id — provider resolution and emit are owned by the service.
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(1);
    const call = queueRegenerateConversationTitleMock.mock.calls[0]?.[0];
    expect(call?.conversationId).toBe("conv-1");
    expect(call).not.toHaveProperty("provider");
    expect(call).not.toHaveProperty("signal");
  });

  test("passes persisted schedule origin when regenerating a standard compatibility row", async () => {
    mockTitleConversation = {
      conversationType: "standard",
      source: "schedule",
    };

    await stop(
      makeStopCtx({
        conversationId: "conv-standard-schedule",
        messages: historyWithUserTurns(3),
      }),
    );
    await flushMacrotasks();

    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledWith({
      conversationId: "conv-standard-schedule",
      context: { origin: "schedule" },
    });
  });

  test("keeps unrecognized persisted origins on configured routing during regeneration", async () => {
    mockTitleConversation = {
      conversationType: "standard",
      source: "custom-background-trigger",
    };

    await stop(
      makeStopCtx({
        conversationId: "conv-custom-background",
        messages: historyWithUserTurns(3),
      }),
    );
    await flushMacrotasks();

    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledWith({
      conversationId: "conv-custom-background",
      context: { origin: "misc" },
    });
  });

  test("lets the service re-read provenance after a transient lookup failure", async () => {
    getConversationMock.mockImplementationOnce(() => {
      throw new Error("database temporarily unavailable");
    });

    await stop(
      makeStopCtx({
        conversationId: "conv-transient-read",
        messages: historyWithUserTurns(3),
      }),
    );
    await flushMacrotasks();

    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledWith({
      conversationId: "conv-transient-read",
    });
  });

  test("defers the regeneration so the completed turn is persisted first", async () => {
    // GIVEN a turn ending on the third user turn
    const ctx = makeStopCtx({ messages: historyWithUserTurns(3) });

    // WHEN the hook resolves
    await stop(ctx);

    // THEN the regeneration has not fired yet — it is deferred to a later
    // macrotask so the turn's assistant reply lands first, AND it fires once
    // the macrotask queue is flushed.
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(0);
    await flushMacrotasks();
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(1);
  });

  test("does not regenerate before the third user turn", async () => {
    // GIVEN a turn ending with only two genuine user prompts
    const ctx = makeStopCtx({ messages: historyWithUserTurns(2) });

    // WHEN the stop hook runs and any deferred work flushes
    await stop(ctx);
    await flushMacrotasks();

    // THEN no regeneration fires — the conversation lacks enough context yet
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(0);
  });

  test("does not regenerate after the third user turn", async () => {
    // GIVEN a turn ending with four genuine user prompts
    const ctx = makeStopCtx({ messages: historyWithUserTurns(4) });

    // WHEN the stop hook runs and any deferred work flushes
    await stop(ctx);
    await flushMacrotasks();

    // THEN no regeneration fires — the single second pass already passed
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(0);
  });

  test("ignores tool-result user messages when counting turns", async () => {
    // GIVEN three genuine user prompts plus a tool-result user message
    const messages: Message[] = [
      userTurn("message 1"),
      assistantTurn("reply 1"),
      userTurn("message 2"),
      assistantTurn("calling a tool"),
      toolResultTurn(),
      assistantTurn("reply 2"),
      userTurn("message 3"),
    ];
    const ctx = makeStopCtx({ messages });

    // WHEN the stop hook runs and its deferred work flushes
    await stop(ctx);
    await flushMacrotasks();

    // THEN the tool-result message is not counted as a turn, so the third
    // genuine prompt still triggers the regeneration
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(1);
  });

  test("does not regenerate on a non-success terminal exit", async () => {
    // GIVEN a third-user-turn stop that ended on a provider error rather than
    // a finalized no-tool reply
    const ctx = makeStopCtx({
      messages: historyWithUserTurns(3),
      exitReason: "error",
      error: new Error("provider rejected"),
    });

    // WHEN the stop hook runs and any deferred work flushes
    await stop(ctx);
    await flushMacrotasks();

    // THEN no regeneration fires — there is no new topic to re-title from
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(0);
  });

  test("respects the skipAutoRetitling opt-out", async () => {
    // GIVEN the user opted out of second-pass retitling
    skipAutoRetitling = true;
    const ctx = makeStopCtx({ messages: historyWithUserTurns(3) });

    // WHEN the stop hook runs on the third user turn and any work flushes
    await stop(ctx);
    await flushMacrotasks();

    // THEN no regeneration fires
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(0);
  });

  test("fires through runHook once the default plugin is registered", async () => {
    // GIVEN the default title-generate plugin registered in the registry
    registerPlugin(defaultTitleGeneratePlugin);

    // WHEN a third-user-turn stop is dispatched through the hook chain
    await runHook(
      HOOKS.STOP,
      makeStopCtx({ messages: historyWithUserTurns(3) }),
    );
    await flushMacrotasks();

    // THEN the second-pass regeneration is triggered
    expect(queueRegenerateConversationTitleMock).toHaveBeenCalledTimes(1);
    expect(
      queueRegenerateConversationTitleMock.mock.calls[0]?.[0]?.conversationId,
    ).toBe("conv-1");
  });

  test("awaits first-pass pooled generation with the completed turn context", async () => {
    // GIVEN a successful first turn on a pooled worker
    pooledRuntime = true;
    let releaseTitle!: () => void;
    const titleBlocked = new Promise<void>((resolve) => {
      releaseTitle = resolve;
    });
    generateConversationTitleRequestBoundMock.mockImplementationOnce(
      async () => {
        await titleBlocked;
        return { title: "Kickoff plan", updated: true };
      },
    );
    let stopSettled = false;

    // WHEN the stop hook starts title generation
    const stopPromise = stop(
      makeStopCtx({ messages: historyWithUserTurns(1) }),
    ).then(() => {
      stopSettled = true;
    });
    await Promise.resolve();

    // THEN it remains request-bound until title persistence settles
    expect(stopSettled).toBe(false);
    expect(generateConversationTitleRequestBoundMock).toHaveBeenCalledWith({
      conversationId: "conv-1",
      userMessage: "message 1",
      assistantResponse: "reply 1",
      context: { origin: "misc" },
    });
    expect(queueGenerateConversationTitleMock).not.toHaveBeenCalled();
    expect(queueRegenerateConversationTitleMock).not.toHaveBeenCalled();

    releaseTitle();
    await stopPromise;
    expect(stopSettled).toBe(true);
  });

  test("regenerates a pooled third-turn title from request-local context", async () => {
    // GIVEN the third successful turn on a pooled worker
    pooledRuntime = true;
    const messages = historyWithUserTurns(3);

    // WHEN the stop hook completes
    await stop(makeStopCtx({ messages }));

    // THEN regeneration is awaited with the latest in-memory transcript,
    // rather than deferred until after the tenant lease is released.
    expect(regenerateConversationTitleRequestBoundMock).toHaveBeenCalledWith({
      conversationId: "conv-1",
      context: { origin: "misc" },
      recentMessages: [
        { role: "assistant", text: "reply 2" },
        { role: "user", text: "message 3" },
        { role: "assistant", text: "reply 3" },
      ],
    });
    expect(queueRegenerateConversationTitleMock).not.toHaveBeenCalled();
  });

  test("contains a request-bound title failure without failing the pooled turn", async () => {
    // GIVEN title generation rejects after the main first-turn reply completed
    pooledRuntime = true;
    generateConversationTitleRequestBoundMock.mockRejectedValueOnce(
      new Error("title provider unavailable"),
    );

    // WHEN the pooled stop hook awaits the title attempt
    const result = stop(makeStopCtx({ messages: historyWithUserTurns(1) }));

    // THEN the title failure remains non-fatal to the user-visible turn
    await expect(result).resolves.toBeUndefined();
    expect(queueGenerateConversationTitleMock).not.toHaveBeenCalled();
  });
});
