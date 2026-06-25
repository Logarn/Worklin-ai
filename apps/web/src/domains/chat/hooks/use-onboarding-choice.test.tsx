import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { DisplayMessage } from "@/domains/chat/types/types";
import { useOnboardingChoice } from "@/domains/chat/hooks/use-onboarding-choice";

const sendMessage = mock((_content: string) => {});

function message(
  id: string,
  role: DisplayMessage["role"],
  text: string,
): DisplayMessage {
  return {
    id,
    role,
    textSegments: [text],
    contentBlocks: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function renderChoice(messages: DisplayMessage[]) {
  return renderHook(() =>
    useOnboardingChoice({
      isNative: true,
      didOnboarding: true,
      messages,
      onboardingTasksEmpty: true,
      activeConversationId: "conv-1",
      onboardingConversationId: "conv-1",
      sendMessage,
    }),
  );
}

afterEach(() => {
  cleanup();
  sendMessage.mockClear();
});

describe("useOnboardingChoice", () => {
  test("shows the chooser after an assistant-only greeting", async () => {
    const { result } = renderChoice([
      message("a1", "assistant", "I'm here whenever you need me."),
    ]);

    await waitFor(() => {
      expect(result.current.showOnboardingChoice).toBe(true);
    });
  });

  test("does not show the chooser once the user has sent a task", async () => {
    const { result } = renderChoice([
      message("a1", "assistant", "I'm here whenever you need me."),
      message("u1", "user", "audit my retention in Klaviyo"),
    ]);

    await waitFor(() => {
      expect(result.current.showOnboardingChoice).toBe(false);
    });
  });
});
