import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import { useAutoSendEffects } from "@/domains/chat/hooks/use-auto-send-effects";

describe("useAutoSendEffects", () => {
  afterEach(() => {
    cleanup();
  });

  test("captures the onboarding initial message before sending consumes storage", async () => {
    const captured: string[] = [];
    const sent: string[] = [];

    renderHook(() =>
      useAutoSendEffects({
        assistantId: "asst-1",
        activeConversationId: "draft-1",
        searchParams: new URLSearchParams(),
        sendMessage: async (content) => {
          sent.push(content);
        },
        reachabilityPhase: "ready",
        reachabilityProbe: () => {},
        getPendingInitialMessage: () => "Hi Atlas, I am Steve. Nice to meet you.",
        onInitialMessageCaptured: (message) => captured.push(message),
      }),
    );

    await waitFor(() => {
      expect(sent).toEqual(["Hi Atlas, I am Steve. Nice to meet you."]);
    });
    expect(captured).toEqual(["Hi Atlas, I am Steve. Nice to meet you."]);
  });
});
