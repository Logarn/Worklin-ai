import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { lifecycleService } from "@/assistant/lifecycle-service";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useAutoGreetGate } from "@/domains/chat/hooks/use-auto-greet-gate";

describe("useAutoGreetGate", () => {
  beforeEach(() => {
    useAssistantLifecycleStore.setState({
      assistantState: { kind: "active", isLocal: false },
      operationalStatusAssistantId: null,
      expectingFirstMessage: false,
    });
    useChatSessionStore.setState({
      messages: [],
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
    useAssistantLifecycleStore.setState({
      assistantState: { kind: "loading" },
      operationalStatusAssistantId: null,
      expectingFirstMessage: false,
    });
    useChatSessionStore.setState({
      messages: [],
      error: null,
    });
  });

  test("clears the first-message gate when a chat error exists", async () => {
    lifecycleService.markExpectingFirstMessage();

    const { rerender, result } = renderHook(
      ({ hasChatError }: { hasChatError: boolean }) =>
        useAutoGreetGate("draft-1", false, null, hasChatError),
      { initialProps: { hasChatError: false } },
    );

    expect(result.current.show).toBe(true);

    rerender({ hasChatError: true });

    await waitFor(() => {
      expect(
        useAssistantLifecycleStore.getState().expectingFirstMessage,
      ).toBe(false);
    });
    expect(result.current.show).toBe(false);
  });
});
