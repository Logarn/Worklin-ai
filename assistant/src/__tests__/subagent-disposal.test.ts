import { describe, expect, test } from "bun:test";

import type { ServerMessage } from "../daemon/message-protocol.js";
import { SubagentManager } from "../subagent/manager.js";
import type { SubagentState } from "../subagent/types.js";

/** Minimal shape matching the private ManagedSubagent interface for test injection. */
interface FakeManagedSubagent {
  conversation: {
    abort: () => void;
    dispose: () => void;
    messages: Array<{
      role: string;
      content: Array<{ type: string; text: string }>;
    }>;
    sendToClient: (msg: ServerMessage) => void;
    persistUserMessage?: () => { id: string; deduplicated: boolean };
    runAgentLoop?: () => Promise<void>;
    enqueueMessage?: () => { rejected: boolean; queued: boolean };
    isProcessing: () => boolean;
    hasQueuedMessages: () => boolean;
    usageStats: {
      inputTokens: number;
      outputTokens: number;
      estimatedCost: number;
    };
  } | null;
  state: SubagentState;
  parentSendToClient: (msg: ServerMessage) => void;
  retainedUntil?: number;
  hadEnqueuedMessages?: boolean;
  pendingParentNotifications?: Array<{
    message: string;
    metadata?: Record<string, unknown>;
  }>;
}

/** Type-safe accessor for SubagentManager's private internals via bracket notation. */
interface ManagerInternals {
  subagents: Map<string, FakeManagedSubagent>;
  parentToChildren: Map<string, Set<string>>;
  runSubagent: (subagentId: string, objective: string) => Promise<void>;
  finalizeWhenSettled: (subagentId: string) => void;
  drainParentNotifications: (subagentId: string) => Promise<void>;
  sweepTerminal: () => void;
  stopSweep: () => void;
}

function asInternals(manager: SubagentManager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

function makeFakeConversation(): NonNullable<
  FakeManagedSubagent["conversation"]
> {
  return {
    abort: () => {},
    dispose: () => {},
    messages: [],
    sendToClient: () => {},
    isProcessing: () => false,
    hasQueuedMessages: () => false,
    usageStats: { inputTokens: 100, outputTokens: 50, estimatedCost: 0.005 },
  };
}

function injectFakeSubagent(
  manager: SubagentManager,
  subagentId: string,
  state: SubagentState,
  parentSendToClient?: (msg: ServerMessage) => void,
  conversation?: FakeManagedSubagent["conversation"],
): void {
  const internals = asInternals(manager);

  internals.subagents.set(subagentId, {
    conversation:
      conversation === undefined ? makeFakeConversation() : conversation,
    state,
    parentSendToClient: parentSendToClient ?? (() => {}),
  });

  const parentId = state.config.parentConversationId;
  if (!internals.parentToChildren.has(parentId)) {
    internals.parentToChildren.set(parentId, new Set());
  }
  internals.parentToChildren.get(parentId)!.add(subagentId);
}

function makeState(
  subagentId: string,
  overrides: Partial<SubagentState> = {},
): SubagentState {
  return {
    config: {
      id: subagentId,
      parentConversationId: "parent-sess-1",
      label: "Test subagent",
      objective: "Do something",
    },
    status: "running",
    conversationId: "conv-sub-1",
    isFork: false,
    createdAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    ...overrides,
  };
}

describe("SubagentManager terminal disposal", () => {
  test("supervisor processes worker notifications before completing", async () => {
    const manager = new SubagentManager();
    const state = makeState("supervisor-1", {
      config: {
        id: "supervisor-1",
        parentConversationId: "root-conv",
        label: "Supervisor",
        objective: "Coordinate workers",
        role: "supervisor",
        overrideProfile: "quality",
      },
      status: "awaiting_children",
      conversationId: "supervisor-conv",
      depth: 1,
      rootConversationId: "root-conv",
    });
    const conversation = makeFakeConversation();
    let persistedContent = "";
    let runOptions: Record<string, unknown> | undefined;
    conversation.persistUserMessage = ((options: { content: string }) => {
      persistedContent = options.content;
      return { id: "worker-notice", deduplicated: false };
    }) as typeof conversation.persistUserMessage;
    conversation.runAgentLoop = (async (
      _content: string,
      _messageId: string,
      options: Record<string, unknown>,
    ) => {
      runOptions = options;
    }) as typeof conversation.runAgentLoop;
    injectFakeSubagent(manager, "supervisor-1", state, undefined, conversation);

    const managed = asInternals(manager).subagents.get("supervisor-1")!;
    managed.pendingParentNotifications = [
      {
        message: '[Subagent "Researcher" completed]\nUse subagent_read.',
      },
    ];

    await asInternals(manager).drainParentNotifications("supervisor-1");

    expect(persistedContent).toContain('Subagent "Researcher" completed');
    expect(runOptions?.callSite).toBe("subagentSpawn");
    expect(runOptions?.overrideProfile).toBe("quality");
    expect(state.status).toBe("completed");
    expect(managed.conversation).toBeNull();

    asInternals(manager).stopSweep();
  });

  test("supervisor remains live until its workers are terminal", () => {
    const manager = new SubagentManager();
    const supervisorState = makeState("supervisor-1", {
      config: {
        id: "supervisor-1",
        parentConversationId: "root-conv",
        label: "Supervisor",
        objective: "Coordinate workers",
        role: "supervisor",
      },
      conversationId: "supervisor-conv",
      depth: 1,
      rootConversationId: "root-conv",
    });
    const workerState = makeState("worker-1", {
      config: {
        id: "worker-1",
        parentConversationId: "supervisor-conv",
        label: "Worker",
        objective: "Research",
        role: "researcher",
      },
      conversationId: "worker-conv",
      depth: 2,
      rootConversationId: "root-conv",
      parentSubagentId: "supervisor-1",
    });
    injectFakeSubagent(manager, "supervisor-1", supervisorState);
    injectFakeSubagent(manager, "worker-1", workerState);

    const internals = asInternals(manager);
    internals.finalizeWhenSettled("supervisor-1");
    expect(supervisorState.status).toBe("awaiting_children");
    expect(
      internals.subagents.get("supervisor-1")!.conversation,
    ).not.toBeNull();

    workerState.status = "completed";
    internals.finalizeWhenSettled("supervisor-1");
    expect(supervisorState.status).toBe("completed");
    expect(internals.subagents.get("supervisor-1")!.conversation).toBeNull();

    internals.stopSweep();
  });

  test("completed subagent has conversation === null but state is preserved", async () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.persistUserMessage = () => ({
      id: "msg-1",
      deduplicated: false,
    });
    managed.conversation!.runAgentLoop = async () => {};

    await asInternals(manager).runSubagent(subagentId, "Do something");

    expect(state.status).toBe("completed");
    expect(managed.conversation).toBeNull();
    // State is still accessible via getState.
    expect(manager.getState(subagentId)).toBeDefined();
    expect(manager.getState(subagentId)!.status).toBe("completed");
    expect(managed.retainedUntil).toBeGreaterThan(Date.now());

    // Cleanup
    asInternals(manager).stopSweep();
  });

  test("failed subagent releases live conversation", async () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.persistUserMessage = () => ({
      id: "msg-1",
      deduplicated: false,
    });
    managed.conversation!.runAgentLoop = async () => {
      throw new Error("LLM error");
    };

    await asInternals(manager).runSubagent(subagentId, "Do something");

    expect(state.status).toBe("failed");
    expect(managed.conversation).toBeNull();
    expect(manager.getState(subagentId)).toBeDefined();

    asInternals(manager).stopSweep();
  });

  test("aborted subagent releases conversation when runSubagent catches", async () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId, { status: "aborted" });
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.persistUserMessage = () => ({
      id: "msg-1",
      deduplicated: false,
    });
    managed.conversation!.runAgentLoop = async () => {
      throw new Error("Conversation aborted");
    };

    await asInternals(manager).runSubagent(subagentId, "Do something");

    expect(managed.conversation).toBeNull();

    asInternals(manager).stopSweep();
  });

  test("sendMessage returns 'terminal' after conversation is released", async () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.persistUserMessage = () => ({
      id: "msg-1",
      deduplicated: false,
    });
    managed.conversation!.runAgentLoop = async () => {};

    await asInternals(manager).runSubagent(subagentId, "Do something");

    expect(managed.conversation).toBeNull();
    const result = await manager.sendMessage(subagentId, "hello");
    expect(result).toBe("terminal");

    asInternals(manager).stopSweep();
  });

  test("parent disposal removes terminal child state", () => {
    const manager = new SubagentManager();
    injectFakeSubagent(
      manager,
      "sub-1",
      makeState("sub-1", { status: "completed" }),
      undefined,
      null, // already released
    );
    asInternals(manager).subagents.get("sub-1")!.retainedUntil =
      Date.now() + 1000;

    // Verify the terminal subagent exists.
    expect(manager.getState("sub-1")).toBeDefined();

    // Parent disposal should remove it.
    manager.abortAllForParent("parent-sess-1");

    expect(manager.getState("sub-1")).toBeUndefined();
    expect(manager.getChildrenOf("parent-sess-1")).toHaveLength(0);
  });

  test("TTL sweep removes expired terminal entries but not active subagents", () => {
    const manager = new SubagentManager();

    // Terminal entry with expired retention.
    injectFakeSubagent(
      manager,
      "sub-expired",
      makeState("sub-expired", { status: "completed" }),
      undefined,
      null,
    );
    asInternals(manager).subagents.get("sub-expired")!.retainedUntil =
      Date.now() - 1000; // already expired

    // Active subagent — no retainedUntil.
    injectFakeSubagent(
      manager,
      "sub-active",
      makeState("sub-active", { status: "running" }),
    );

    // Terminal but not yet expired.
    injectFakeSubagent(
      manager,
      "sub-fresh",
      makeState("sub-fresh", { status: "completed" }),
      undefined,
      null,
    );
    asInternals(manager).subagents.get("sub-fresh")!.retainedUntil =
      Date.now() + 60_000;

    asInternals(manager).sweepTerminal();

    expect(manager.getState("sub-expired")).toBeUndefined();
    expect(manager.getState("sub-active")).toBeDefined();
    expect(manager.getState("sub-fresh")).toBeDefined();

    asInternals(manager).stopSweep();
  });

  test("dispose handles already-released conversation gracefully", () => {
    const manager = new SubagentManager();
    injectFakeSubagent(
      manager,
      "sub-1",
      makeState("sub-1", { status: "completed" }),
      undefined,
      null, // conversation already released
    );

    // Should not throw.
    manager.dispose("sub-1");
    expect(manager.getState("sub-1")).toBeUndefined();
  });

  test("usage stats are preserved after conversation release", async () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.usageStats = {
      inputTokens: 500,
      outputTokens: 200,
      estimatedCost: 0.05,
    };
    managed.conversation!.persistUserMessage = () => ({
      id: "msg-1",
      deduplicated: false,
    });
    managed.conversation!.runAgentLoop = async () => {};

    await asInternals(manager).runSubagent(subagentId, "Do something");

    expect(managed.conversation).toBeNull();
    expect(state.usage).toEqual({
      inputTokens: 500,
      outputTokens: 200,
      estimatedCost: 0.05,
    });

    asInternals(manager).stopSweep();
  });

  test("defers release when messages were enqueued during run", async () => {
    const manager = new SubagentManager();
    const subagentId = "sub-1";
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const managed = asInternals(manager).subagents.get(subagentId)!;
    managed.conversation!.persistUserMessage = () => ({
      id: "msg-1",
      deduplicated: false,
    });
    managed.conversation!.runAgentLoop = async () => {};
    // Simulate that a message was enqueued during the run.
    managed.hadEnqueuedMessages = true;

    await asInternals(manager).runSubagent(subagentId, "Do something");

    // Conversation should NOT be released — drain may still be active.
    expect(managed.conversation).not.toBeNull();
    // But retainedUntil should be set for eventual TTL cleanup.
    expect(managed.retainedUntil).toBeGreaterThan(Date.now());
    expect(state.status).toBe("completed");

    asInternals(manager).stopSweep();
  });
});
