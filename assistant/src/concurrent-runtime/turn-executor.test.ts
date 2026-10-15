import { describe, expect, test } from "bun:test";

import { buildConcurrentProviderMessages } from "./turn-executor.js";

describe("buildConcurrentProviderMessages", () => {
  test("keeps onboarding details in the first user message without duplicating its initial message", () => {
    const messages = buildConcurrentProviderMessages(
      [
        {
          id: "message-1",
          organizationId: "org-1",
          assistantId: "assistant-1",
          conversationId: "conversation-1",
          role: "user",
          content: "Build my store page",
          createdAt: new Date(0).toISOString(),
        },
      ],
      [],
      {
        tools: ["Gmail"],
        tasks: ["sales page"],
        tone: "direct",
        brandName: "ChickMagnet",
        contentSourceUrl: "https://chickmagnet.xyz/about",
        initialMessage: "Build my store page",
      },
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(JSON.stringify(messages[0]?.content)).toContain("ChickMagnet");
    expect(JSON.stringify(messages[0]?.content)).toContain(
      "https://chickmagnet.xyz/about",
    );
    expect(JSON.stringify(messages[0]?.content)).not.toContain(
      '"initialMessage"',
    );
    expect(JSON.stringify(messages[0]?.content)).not.toContain(
      "First-run context",
    );
  });
});
