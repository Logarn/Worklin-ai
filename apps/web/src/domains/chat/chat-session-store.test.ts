import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";

beforeEach(() => {
  useChatSessionStore.setState({
    messages: [{ id: "m1", content: "hello", role: "assistant" } as never],
    error: { type: "error", message: "x", scope: "chat" } as never,
    isLoadingHistory: false,
    transcriptPagination: {
      hasMore: true,
      oldestTimestamp: "2026-01-01T00:00:00Z",
      isLoadingOlder: true,
      isPinnedToLatest: false,
    } as never,
    contextWindowUsage: { total: 123 } as never,
    compactionCircuitOpenUntil: new Date("2026-01-01T00:00:00Z"),
    dismissedSurfaceIds: new Set(["a"]),
    streamingMessageIds: new Set(["m1"]),
    pendingQueuedMessageIds: ["q1"],
    requestIdToMessageId: new Map([["r1", "m1"]]),
    pendingLocalDeletions: new Set(["d1"]),
    expandedToolCallIds: new Set(["x"]),
    expandedCardIds: new Map([["c1", true]]),
    confirmationToolCallMap: new Map([["r1", "tool-1"]]),
    contextWindowUsageByConversation: new Map([["c", { total: 42 } as never]]),
    previousConversationId: "conv-1",
    previousAssistantId: "assistant-1",
    draftConversationIdResolution: true,
    switchResetPending: true,
    lastAppliedDataTimestamp: 99_000,
  });
});

afterEach(() => {
  useChatSessionStore.getState().reset();
});

describe("chat-session-store", () => {
  test("reset restores the initial session state", () => {
    useChatSessionStore.getState().reset();
    const state = useChatSessionStore.getState();

    expect(state.messages).toEqual([]);
    expect(state.error).toBeNull();
    expect(state.isLoadingHistory).toBe(true);
    expect(state.transcriptPagination).toMatchObject({
      hasMore: false,
      oldestTimestamp: null,
      isLoadingOlder: false,
      isPinnedToLatest: true,
    });
    expect(state.contextWindowUsage).toBeNull();
    expect(state.compactionCircuitOpenUntil).toBeNull();
    expect(state.dismissedSurfaceIds.size).toBe(0);
    expect(state.streamingMessageIds.size).toBe(0);
    expect(state.pendingQueuedMessageIds).toEqual([]);
    expect(state.requestIdToMessageId.size).toBe(0);
    expect(state.pendingLocalDeletions.size).toBe(0);
    expect(state.confirmationToolCallMap.size).toBe(0);
    expect(state.expandedToolCallIds.size).toBe(0);
    expect(state.expandedCardIds.size).toBe(0);
    expect(state.contextWindowUsageByConversation.size).toBe(0);
    expect(state.previousConversationId).toBeNull();
    expect(state.previousAssistantId).toBeNull();
    expect(state.draftConversationIdResolution).toBe(false);
    expect(state.switchResetPending).toBe(false);
    expect(state.lastAppliedDataTimestamp).toBe(0);
  });
});

