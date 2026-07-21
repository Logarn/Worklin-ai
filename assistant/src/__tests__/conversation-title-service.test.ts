import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ConfiguredProviderOptions } from "../providers/provider-send-message.js";
import type { Provider } from "../providers/types.js";

const mockRunBtwSidechain = mock(async (_params: Record<string, unknown>) => ({
  text: "Project kickoff",
  hadTextDeltas: true,
  response: {
    content: [{ type: "text", text: "Project kickoff" }],
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: "end_turn",
  },
}));

interface MockConversation {
  title: string | null;
  isAutoTitle: number;
  conversationType?: "standard" | "background" | "scheduled";
  source?: string | null;
  originChannel?: string | null;
  inferenceProfile?: string | null;
  inferenceProfileExpiresAt?: number | null;
}

const mockGetConversation = mock(
  (_conversationId: string) =>
    ({
      title: "Generating title...",
      isAutoTitle: 1,
      conversationType: "standard",
      inferenceProfile: null,
      inferenceProfileExpiresAt: null,
    }) as MockConversation,
);
const mockGetMessages = mock(() => [
  { role: "user", content: "first message" },
  { role: "assistant", content: "first reply" },
  { role: "user", content: "follow-up" },
]);
const mockUpdateConversationTitle = mock(() => {});
const mockGetConfiguredProvider = mock(
  async (
    _callSite: string,
    _options: ConfiguredProviderOptions = {},
  ): Promise<Provider | null> => null,
);

interface MockConfig {
  llm: {
    default?: Record<string, unknown>;
    profiles: Record<string, Record<string, unknown>>;
    activeProfile?: string;
  };
}

function defaultMockConfig(): MockConfig {
  return {
    llm: {
      default: { provider: "anthropic", model: "test-model" },
      profiles: {},
    },
  };
}

let mockConfig: MockConfig = defaultMockConfig();
const mockGetConfig = mock(() => mockConfig);

function makeProvider(name: string): Provider {
  return {
    name,
    sendMessage: mock(async () => {
      throw new Error("provider.sendMessage should not be called directly");
    }),
  };
}

mock.module("../config/loader.js", () => ({
  getConfig: mockGetConfig,
}));

mock.module("../runtime/btw-sidechain.js", () => ({
  runBtwSidechain: mockRunBtwSidechain,
}));

mock.module("../memory/conversation-crud.js", () => ({
  getConversation: mockGetConversation,
  getMessages: mockGetMessages,
  resolveOverrideProfile: (conversation: {
    conversationType?: string;
    inferenceProfile?: string | null;
    inferenceProfileExpiresAt?: number | null;
  }) => {
    if (
      conversation?.conversationType === "background" ||
      conversation?.conversationType === "scheduled"
    ) {
      return undefined;
    }
    if (
      conversation?.inferenceProfileExpiresAt != null &&
      conversation.inferenceProfileExpiresAt <= Date.now()
    ) {
      return undefined;
    }
    return conversation?.inferenceProfile ?? undefined;
  },
  updateConversationTitle: mockUpdateConversationTitle,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../providers/provider-send-message.js", () => ({
  getConfiguredProvider: mockGetConfiguredProvider,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const mockPublishConversationTitleChanged = mock(
  (_conversationId: string, _title: string) => {},
);
mock.module("../runtime/sync/resource-sync-events.js", () => ({
  publishConversationTitleChanged: mockPublishConversationTitleChanged,
}));

import {
  AUTO_TITLE_DETERMINISTIC,
  generateAndPersistConversationTitle,
  queueGenerateConversationTitle,
  regenerateConversationTitle,
  regenerateConversationTitleRequestBound,
  repairConversationTitle,
  titleMutex,
  type TitleOrigin,
} from "../memory/conversation-title-service.js";

describe("conversation-title-service", () => {
  beforeEach(() => {
    mockRunBtwSidechain.mockClear();
    mockRunBtwSidechain.mockImplementation(async () => ({
      text: "Project kickoff",
      hadTextDeltas: true,
      response: {
        content: [{ type: "text", text: "Project kickoff" }],
        model: "test-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "end_turn",
      },
    }));
    mockGetConversation.mockClear();
    mockGetConversation.mockImplementation(
      () =>
        ({
          title: "Generating title...",
          isAutoTitle: 1,
          inferenceProfile: null,
          inferenceProfileExpiresAt: null,
          conversationType: "standard",
        }) as any,
    );
    mockGetMessages.mockClear();
    mockGetMessages.mockImplementation(() => [
      { role: "user", content: "first message" },
      { role: "assistant", content: "first reply" },
      { role: "user", content: "follow-up" },
    ]);
    mockUpdateConversationTitle.mockClear();
    mockGetConfiguredProvider.mockClear();
    mockGetConfiguredProvider.mockImplementation(async () => null);
    mockGetConfig.mockClear();
    mockGetConfig.mockImplementation(() => mockConfig);
    mockPublishConversationTitleChanged.mockClear();
    mockConfig = defaultMockConfig();
  });

  test("uses the BTW side-chain helper for initial title generation", async () => {
    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("provider.sendMessage should not be called directly");
      }),
    };

    const result = await generateAndPersistConversationTitle({
      conversationId: "conv-1",
      provider,
      userMessage: "Help me plan the kickoff",
    });

    expect(result).toEqual({ title: "Project kickoff", updated: true });
    expect(mockRunBtwSidechain).toHaveBeenCalledTimes(1);
    expect(mockRunBtwSidechain).toHaveBeenCalledWith(
      expect.objectContaining({
        provider,
        systemPrompt: expect.stringContaining("conversation titles"),
        tools: [],
        callSite: "conversationTitle",
        timeoutMs: 15_000,
      }),
    );
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      "conv-1",
      "Project kickoff",
      1,
    );
    // Emit is service-native: persisting a title broadcasts the update so
    // every title origin (agent loop, bootstrap, voice) updates clients live.
    expect(mockPublishConversationTitleChanged).toHaveBeenCalledWith(
      "conv-1",
      "Project kickoff",
    );
  });

  test("uses the active chat profile when a managed title profile is still enabled", async () => {
    const provider = makeProvider("openai-compatible");
    mockGetConfiguredProvider.mockResolvedValueOnce(provider);
    mockGetConfig.mockImplementationOnce(() => ({
      llm: {
        default: {
          provider: "anthropic",
          provider_connection: "anthropic-managed",
        },
        profiles: {
          "cost-optimized": {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
          },
          "custom-balanced": {
            source: "user",
            provider: "openai-compatible",
            provider_connection: "xai-personal",
          },
        },
        activeProfile: "custom-balanced",
      },
    }));

    const result = await generateAndPersistConversationTitle({
      conversationId: "conv-1",
      userMessage: "Draft a launch email sequence",
    });

    expect(result).toEqual({ title: "Project kickoff", updated: true });
    expect(mockGetConfiguredProvider).toHaveBeenCalledWith(
      "conversationTitle",
      {
        forceOverrideProfile: true,
        overrideProfile: "custom-balanced",
        selectionSeed: "conv-1",
      },
    );
  });

  test("keeps a standard-row manual schedule on configured title routing", async () => {
    const provider = makeProvider("anthropic");
    mockGetConversation.mockReturnValue({
      title: "Generating title...",
      isAutoTitle: AUTO_TITLE_DETERMINISTIC,
      conversationType: "standard",
      inferenceProfile: null,
      inferenceProfileExpiresAt: null,
    });
    mockGetConfiguredProvider.mockResolvedValueOnce(provider);

    await generateAndPersistConversationTitle({
      conversationId: "conv-manual-schedule",
      context: {
        origin: "schedule",
        systemHint: "Schedule (manual): Launch report",
      },
      userMessage: "Prepare the launch report",
    });

    expect(mockGetConfiguredProvider).toHaveBeenCalledWith(
      "conversationTitle",
      { selectionSeed: "conv-manual-schedule" },
    );
    expect(mockGetConfig).not.toHaveBeenCalled();
  });

  test("keeps every system title origin on configured title routing", async () => {
    const provider = makeProvider("anthropic");
    const systemOrigins: TitleOrigin[] = [
      "guardian_request",
      "schedule",
      "task",
      "watcher",
      "subagent",
      "sequence",
      "heartbeat",
      "filing",
      "task_submit",
      "memory_consolidation",
      "memory_retrospective",
      "misc",
    ];
    mockGetConfiguredProvider.mockResolvedValue(provider);

    for (const origin of systemOrigins) {
      const conversationId = `conv-${origin}`;
      await generateAndPersistConversationTitle({
        conversationId,
        context: { origin },
        userMessage: "Run the system job",
      });
      expect(mockGetConfiguredProvider).toHaveBeenLastCalledWith(
        "conversationTitle",
        { selectionSeed: conversationId },
      );
    }

    expect(mockGetConfig).not.toHaveBeenCalled();
  });

  test("keeps standard runtime, channel, and voice titles on the active chat profile", async () => {
    const provider = makeProvider("openai-compatible");
    const interactiveOrigins: TitleOrigin[] = [
      "runtime_api",
      "channel_inbound",
      "voice_inbound",
      "voice_outbound",
      "local",
    ];
    mockGetConfiguredProvider.mockResolvedValue(provider);
    mockGetConfig.mockImplementation(() => ({
      llm: {
        default: {
          provider: "anthropic",
          provider_connection: "anthropic-managed",
        },
        profiles: {
          "custom-balanced": {
            source: "user",
            provider: "openai-compatible",
            provider_connection: "xai-personal",
          },
        },
        activeProfile: "custom-balanced",
      },
    }));

    for (const origin of interactiveOrigins) {
      const conversationId = `conv-${origin}`;
      await generateAndPersistConversationTitle({
        conversationId,
        context: { origin },
        userMessage: "Draft a launch plan",
      });
      expect(mockGetConfiguredProvider).toHaveBeenLastCalledWith(
        "conversationTitle",
        {
          forceOverrideProfile: true,
          overrideProfile: "custom-balanced",
          selectionSeed: conversationId,
        },
      );
    }
  });

  test("keeps a human channel first pass on its pinned chat profile", async () => {
    const provider = makeProvider("openai-compatible");
    mockGetConversation.mockReturnValue({
      title: "Generating title...",
      isAutoTitle: AUTO_TITLE_DETERMINISTIC,
      conversationType: "standard",
      source: "user",
      originChannel: "slack",
      inferenceProfile: "custom-channel",
      inferenceProfileExpiresAt: null,
    });
    mockGetConfiguredProvider.mockResolvedValueOnce(provider);

    await generateAndPersistConversationTitle({
      conversationId: "conv-human-channel",
      userMessage: "Summarize this customer thread",
    });

    expect(mockGetConfiguredProvider).toHaveBeenCalledWith(
      "conversationTitle",
      {
        forceOverrideProfile: true,
        overrideProfile: "custom-channel",
        selectionSeed: "conv-human-channel",
      },
    );
  });

  test("keeps background conversations on their configured title routing", async () => {
    const provider = makeProvider("anthropic");
    mockGetConversation.mockReturnValue({
      title: "Generating title...",
      isAutoTitle: AUTO_TITLE_DETERMINISTIC,
      conversationType: "background",
      inferenceProfile: "custom-balanced",
      inferenceProfileExpiresAt: null,
    });
    mockGetConfiguredProvider.mockResolvedValueOnce(provider);

    await generateAndPersistConversationTitle({
      conversationId: "conv-background",
      context: { origin: "subagent", systemHint: "Background research" },
    });

    expect(mockGetConfiguredProvider).toHaveBeenCalledWith(
      "conversationTitle",
      { selectionSeed: "conv-background" },
    );
    expect(mockGetConfig).not.toHaveBeenCalled();
  });

  test("title regeneration keeps pinned profiles for runtime, channel, and voice origins", async () => {
    const provider = makeProvider("openai-compatible");
    const interactiveRows: Array<
      Pick<MockConversation, "source" | "originChannel">
    > = [
      { source: "user", originChannel: "vellum" },
      { source: "slack", originChannel: "slack" },
      { source: "user", originChannel: "phone" },
    ];
    mockGetConfiguredProvider.mockResolvedValue(provider);

    for (const [index, row] of interactiveRows.entries()) {
      const conversationId = `conv-interactive-${index}`;
      mockGetConversation.mockReturnValue({
        title: "Untitled Conversation",
        isAutoTitle: AUTO_TITLE_DETERMINISTIC,
        conversationType: "standard",
        ...row,
        inferenceProfile: "custom-quality",
        inferenceProfileExpiresAt: null,
      });

      const result = await regenerateConversationTitle({ conversationId });

      expect(result).toEqual({ title: "Project kickoff", updated: true });
      expect(mockGetConfiguredProvider).toHaveBeenLastCalledWith(
        "conversationTitle",
        {
          forceOverrideProfile: true,
          overrideProfile: "custom-quality",
          selectionSeed: conversationId,
        },
      );
    }
  });

  test("standard-row schedule and background regeneration keep configured title routing", async () => {
    const provider = makeProvider("anthropic");
    mockGetConfiguredProvider.mockResolvedValue(provider);

    for (const source of ["schedule", "background"] as const) {
      const conversationId = `conv-${source}-regeneration`;
      mockGetConversation.mockReturnValue({
        title: "Untitled Conversation",
        isAutoTitle: AUTO_TITLE_DETERMINISTIC,
        conversationType: "standard",
        source,
        originChannel: "slack",
        inferenceProfile: "custom-quality",
        inferenceProfileExpiresAt: null,
      });

      const result = await regenerateConversationTitle({ conversationId });

      expect(result).toEqual({ title: "Project kickoff", updated: true });
      expect(mockGetConfiguredProvider).toHaveBeenLastCalledWith(
        "conversationTitle",
        { selectionSeed: conversationId },
      );
    }

    expect(mockGetConfig).not.toHaveBeenCalled();
  });

  test("regeneration extracts text from JSON content blocks", async () => {
    mockGetMessages.mockReturnValueOnce([
      {
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Help me plan the kickoff" },
        ]),
      },
      {
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "Sure, here's a plan" },
          { type: "tool_use", id: "toolu_1", name: "web_search", input: {} },
        ]),
      },
      {
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Looks good" }]),
      },
    ]);

    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("should not call directly");
      }),
    };

    await regenerateConversationTitle({ conversationId: "conv-1", provider });

    // The prompt sent to the sidechain should contain plain text, not raw JSON
    const prompt = (mockRunBtwSidechain.mock.calls[0] as any)?.[0]
      ?.content as string;
    expect(prompt).not.toContain('"type":"text"');
    expect(prompt).not.toContain('"type":"tool_use"');
    // Tool metadata should NOT appear in the title prompt
    expect(prompt).not.toContain("Tool use");
    expect(prompt).not.toContain("web_search");
    expect(prompt).toContain("Help me plan the kickoff");
    expect(prompt).toContain("Sure, here's a plan");
    expect(prompt).toContain("Looks good");
  });

  test("regeneration extracts text from tool_result content blocks", async () => {
    mockGetMessages.mockReturnValueOnce([
      {
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Search for restaurants" },
        ]),
      },
      {
        role: "assistant",
        content: JSON.stringify([
          { type: "tool_use", id: "toolu_1", name: "web_search", input: {} },
        ]),
      },
      {
        role: "user",
        content: JSON.stringify([
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "Found 3 restaurants nearby",
          },
        ]),
      },
    ]);

    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("should not call directly");
      }),
    };

    await regenerateConversationTitle({ conversationId: "conv-1", provider });

    const prompt = (mockRunBtwSidechain.mock.calls[0] as any)?.[0]
      ?.content as string;
    expect(prompt).not.toContain('"type":"tool_result"');
    // Tool-only assistant message should be skipped entirely
    expect(prompt).not.toContain("Tool use");
    expect(prompt).toContain("Search for restaurants");
    expect(prompt).toContain("Found 3 restaurants nearby");
  });

  test("uses the BTW side-chain helper for title regeneration", async () => {
    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("provider.sendMessage should not be called directly");
      }),
    };

    const result = await regenerateConversationTitle({
      conversationId: "conv-1",
      provider,
    });

    expect(result).toEqual({ title: "Project kickoff", updated: true });
    expect(mockRunBtwSidechain).toHaveBeenCalledTimes(1);
    expect(mockRunBtwSidechain).toHaveBeenCalledWith(
      expect.objectContaining({
        provider,
        systemPrompt: expect.stringContaining("conversation titles"),
        tools: [],
        callSite: "conversationTitle",
        timeoutMs: 15_000,
      }),
    );
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      "conv-1",
      "Project kickoff",
      1,
    );
  });

  test("request-bound regeneration persists a title from in-memory turn context", async () => {
    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("provider.sendMessage should not be called directly");
      }),
    };

    const result = await regenerateConversationTitleRequestBound({
      conversationId: "conv-1",
      provider,
      recentMessages: [
        { role: "assistant", text: "We narrowed the launch to Nairobi" },
        { role: "user", text: "Build the investor demo checklist" },
        { role: "assistant", text: "Here is the launch checklist" },
      ],
    });

    expect(result).toEqual({ title: "Project kickoff", updated: true });
    expect(mockGetMessages).not.toHaveBeenCalled();
    expect(mockRunBtwSidechain).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [
          "Recent messages:",
          "Assistant: We narrowed the launch to Nairobi",
          "User: Build the investor demo checklist",
          "Assistant: Here is the launch checklist",
        ].join("\n"),
      }),
    );
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      "conv-1",
      "Project kickoff",
      1,
    );
    expect(mockPublishConversationTitleChanged).toHaveBeenCalledWith(
      "conv-1",
      "Project kickoff",
    );
  });

  test("rejects meta-failure outputs like 'Missing Context' and uses fallback", async () => {
    mockRunBtwSidechain.mockImplementationOnce(async () => ({
      text: "Missing Context",
      hadTextDeltas: true,
      response: {
        content: [{ type: "text", text: "Missing Context" }],
        model: "test-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "end_turn",
      },
    }));

    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("should not call directly");
      }),
    };

    const result = await generateAndPersistConversationTitle({
      conversationId: "conv-1",
      provider,
      userMessage: "so about that t-shirt...",
    });

    expect(result.title).toBe("Untitled Conversation");
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      "conv-1",
      "Untitled Conversation",
      AUTO_TITLE_DETERMINISTIC,
    );
  });

  test.each([
    "missing context",
    "No Context",
    "Insufficient Context",
    "Unclear Request",
    "No Topic",
    "Empty Conversation",
  ])("rejects meta-failure variant: %s", async (bad) => {
    mockRunBtwSidechain.mockImplementationOnce(async () => ({
      text: bad,
      hadTextDeltas: true,
      response: {
        content: [{ type: "text", text: bad }],
        model: "test-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "end_turn",
      },
    }));

    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("should not call directly");
      }),
    };

    const result = await generateAndPersistConversationTitle({
      conversationId: "conv-1",
      provider,
      userMessage: "something",
    });

    expect(result.title).toBe("Untitled Conversation");
  });

  test("regeneration skips LLM call when recent messages have no extractable text", async () => {
    mockGetMessages.mockReturnValueOnce([
      {
        role: "assistant",
        content: JSON.stringify([
          { type: "tool_use", id: "toolu_1", name: "bash", input: {} },
        ]),
      },
      {
        role: "user",
        content: JSON.stringify([
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "image", source: {} }],
          },
        ]),
      },
      {
        role: "assistant",
        content: JSON.stringify([
          { type: "tool_use", id: "toolu_2", name: "bash", input: {} },
        ]),
      },
    ]);

    mockGetConversation.mockReturnValueOnce({
      title: "Existing Title",
      isAutoTitle: 1,
    });

    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("should not call directly");
      }),
    };

    const result = await regenerateConversationTitle({
      conversationId: "conv-1",
      provider,
    });

    expect(mockRunBtwSidechain).not.toHaveBeenCalled();
    expect(mockUpdateConversationTitle).not.toHaveBeenCalled();
    expect(result).toEqual({ title: "Existing Title", updated: false });
  });

  test("title prompt content does not contain generation instructions", async () => {
    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("provider.sendMessage should not be called directly");
      }),
    };

    await generateAndPersistConversationTitle({
      conversationId: "conv-1",
      provider,
      userMessage: "Help me plan the kickoff",
    });

    const call = mockRunBtwSidechain.mock.calls[0]![0] as {
      content: string;
      systemPrompt: string;
    };
    // Instructions should be in systemPrompt, not in content
    expect(call.content).not.toContain("Generate a very short title");
    expect(call.content).not.toContain("do NOT respond");
    expect(call.systemPrompt).toContain("Do NOT respond");
  });

  test("uses the conversation's BYOK profile for title generation", async () => {
    const provider = {
      name: "openai",
      sendMessage: mock(async () => {
        throw new Error("should not call directly");
      }),
    };
    mockConfig = {
      llm: {
        activeProfile: "custom-balanced",
        profiles: {
          "custom-balanced": {
            source: "user",
            model: "gpt-test",
          },
        },
      },
    };
    mockGetConversation.mockReturnValue({
      title: "New Conversation",
      isAutoTitle: 0,
      inferenceProfile: "custom-balanced",
      inferenceProfileExpiresAt: null,
      conversationType: "standard",
    });
    mockGetConfiguredProvider.mockResolvedValue(provider);

    const result = await generateAndPersistConversationTitle({
      conversationId: "conv-1",
      userMessage: "Plan the product launch",
    });

    expect(result.title).toBe("Project kickoff");
    expect(mockGetConfiguredProvider).toHaveBeenCalledWith(
      "conversationTitle",
      {
        overrideProfile: "custom-balanced",
        forceOverrideProfile: true,
        selectionSeed: "conv-1",
      },
    );
    expect(mockRunBtwSidechain).toHaveBeenCalledWith(
      expect.objectContaining({ provider }),
    );
  });

  test("falls back from an inaccessible BYOK speed profile to the active BYOK profile", async () => {
    const speedProvider = {
      name: "openai-speed",
      sendMessage: mock(async () => {
        throw new Error("should not call directly");
      }),
    };
    const activeProvider = {
      name: "openai-active",
      sendMessage: mock(async () => {
        throw new Error("should not call directly");
      }),
    };
    mockConfig = {
      llm: {
        activeProfile: "custom-balanced",
        profiles: {
          "custom-cost-optimized": {
            source: "user",
            model: "gpt-speed-test",
          },
          "custom-balanced": {
            source: "user",
            model: "gpt-balanced-test",
          },
        },
      },
    };
    mockGetConversation.mockReturnValue({
      title: "New Conversation",
      isAutoTitle: 0,
      inferenceProfile: null,
      inferenceProfileExpiresAt: null,
      conversationType: "standard",
    });
    mockGetConfiguredProvider.mockImplementation(
      async (_callSite, options: { overrideProfile?: string } = {}) =>
        options.overrideProfile === "custom-cost-optimized"
          ? speedProvider
          : activeProvider,
    );
    mockRunBtwSidechain.mockImplementation(
      async (params: { provider?: { name: string } }) => {
        if (params.provider === speedProvider) {
          throw new Error("model unavailable");
        }
        return {
          text: "Launch Planning",
          hadTextDeltas: true,
          response: {
            content: [{ type: "text", text: "Launch Planning" }],
            model: "gpt-balanced-test",
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: "end_turn",
          },
        };
      },
    );

    const result = await generateAndPersistConversationTitle({
      conversationId: "conv-1",
      userMessage: "Plan the product launch",
    });

    expect(result.title).toBe("Launch Planning");
    expect(mockRunBtwSidechain).toHaveBeenCalledTimes(2);
    expect(mockGetConfiguredProvider.mock.calls.map((call) => call[1])).toEqual(
      [
        {
          overrideProfile: "custom-cost-optimized",
          forceOverrideProfile: true,
          selectionSeed: "conv-1",
        },
        {
          overrideProfile: "custom-balanced",
          forceOverrideProfile: true,
          selectionSeed: "conv-1",
        },
      ],
    );
  });

  test("does not silently fall back to a managed title profile when BYOK resolution fails", async () => {
    mockConfig = {
      llm: {
        activeProfile: "custom-balanced",
        profiles: {
          "custom-balanced": {
            source: "user",
            model: "gpt-test",
          },
          "cost-optimized": {
            source: "managed",
            model: "managed-test",
          },
        },
      },
    };
    mockGetConversation.mockReturnValue({
      title: "New Conversation",
      isAutoTitle: 0,
      inferenceProfile: "cost-optimized",
      inferenceProfileExpiresAt: null,
      conversationType: "standard",
    });
    mockGetConfiguredProvider.mockResolvedValue(null);

    const result = await generateAndPersistConversationTitle({
      conversationId: "conv-1",
      userMessage: "Plan the product launch",
    });

    expect(result.title).toBe("Untitled Conversation");
    expect(mockGetConfiguredProvider).toHaveBeenCalledTimes(1);
    expect(mockGetConfiguredProvider).toHaveBeenCalledWith(
      "conversationTitle",
      expect.objectContaining({
        overrideProfile: "custom-balanced",
        forceOverrideProfile: true,
      }),
    );
    expect(mockRunBtwSidechain).not.toHaveBeenCalled();
  });

  test("repairs an abandoned generating placeholder from persisted messages on demand", async () => {
    const provider = {
      name: "openai",
      sendMessage: mock(async () => {
        throw new Error("should not call directly");
      }),
    };
    mockConfig = {
      llm: {
        activeProfile: "custom-balanced",
        profiles: {
          "custom-balanced": {
            source: "user",
            model: "gpt-test",
          },
        },
      },
    };
    mockGetConfiguredProvider.mockResolvedValue(provider);

    const result = await repairConversationTitle({
      conversationId: "conv-1",
    });

    expect(result).toEqual({ title: "Project kickoff", updated: true });
    expect(mockRunBtwSidechain).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("first message"),
      }),
    );
  });

  test("settles an abandoned generating placeholder without messages to a stable fallback", async () => {
    mockGetMessages.mockReturnValueOnce([]);

    const result = await repairConversationTitle({
      conversationId: "conv-1",
    });

    expect(result).toEqual({
      title: "Untitled Conversation",
      updated: true,
    });
    expect(mockGetConfiguredProvider).not.toHaveBeenCalled();
    expect(mockRunBtwSidechain).not.toHaveBeenCalled();
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(
      "conv-1",
      "Untitled Conversation",
      AUTO_TITLE_DETERMINISTIC,
    );
  });

  test("queueGenerateConversationTitle serializes concurrent calls", async () => {
    const callOrder: string[] = [];
    let resolveFirst!: () => void;
    const firstBlocked = new Promise<void>((r) => {
      resolveFirst = r;
    });

    // First call: blocks until we release it
    mockRunBtwSidechain.mockImplementationOnce(async () => {
      callOrder.push("first:start");
      await firstBlocked;
      callOrder.push("first:end");
      return {
        text: "Title One",
        hadTextDeltas: true,
        response: {
          content: [{ type: "text", text: "Title One" }],
          model: "test-model",
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: "end_turn",
        },
      };
    });

    // Second call: resolves immediately
    mockRunBtwSidechain.mockImplementationOnce(async () => {
      callOrder.push("second:start");
      return {
        text: "Title Two",
        hadTextDeltas: true,
        response: {
          content: [{ type: "text", text: "Title Two" }],
          model: "test-model",
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: "end_turn",
        },
      };
    });

    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("should not call directly");
      }),
    };

    // Fire both calls — without serialization both would start immediately
    queueGenerateConversationTitle({
      conversationId: "conv-1",
      provider,
      userMessage: "first message",
    });
    queueGenerateConversationTitle({
      conversationId: "conv-2",
      provider,
      userMessage: "second message",
    });

    // Let microtasks settle — only the first call should have started
    await new Promise((r) => setTimeout(r, 10));
    expect(callOrder).toEqual(["first:start"]);

    // Release the first call
    resolveFirst();
    await titleMutex.withLock(async () => {});

    // Second should have started only after first finished
    expect(callOrder).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("queue continues processing after a failed call", async () => {
    // First call: throws
    mockRunBtwSidechain.mockImplementationOnce(async () => {
      throw new Error("provider timeout");
    });

    // Second call: succeeds
    mockRunBtwSidechain.mockImplementationOnce(async () => ({
      text: "Recovery Title",
      hadTextDeltas: true,
      response: {
        content: [{ type: "text", text: "Recovery Title" }],
        model: "test-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "end_turn",
      },
    }));

    const provider = {
      name: "test-provider",
      sendMessage: mock(async () => {
        throw new Error("should not call directly");
      }),
    };

    queueGenerateConversationTitle({
      conversationId: "conv-1",
      provider,
      userMessage: "will fail",
    });
    queueGenerateConversationTitle({
      conversationId: "conv-2",
      provider,
      userMessage: "will succeed",
    });

    await titleMutex.withLock(async () => {});

    // Both calls went through — failure didn't break the chain
    expect(mockRunBtwSidechain).toHaveBeenCalledTimes(2);
    // Second conversation got a proper title
    const secondUpdate = (
      mockUpdateConversationTitle.mock.calls as unknown as string[][]
    ).find((c) => c[0] === "conv-2" && c[1] === "Recovery Title");
    expect(secondUpdate).toBeTruthy();
  });
});
