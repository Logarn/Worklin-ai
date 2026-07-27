import { describe, expect, test } from "bun:test";

import {
  activeConversationAgentLoopCount,
  trackConversationAgentLoop,
} from "../conversation-agent-loop-registry.js";

describe("conversation agent loop registry", () => {
  test("keeps a loop active until its actual promise settles", async () => {
    let resolveRun!: () => void;
    const run = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });

    const tracked = trackConversationAgentLoop(run);
    expect(activeConversationAgentLoopCount()).toBe(1);

    resolveRun();
    await tracked;
    expect(activeConversationAgentLoopCount()).toBe(0);
  });

  test("removes rejected loops after propagating the failure", async () => {
    const tracked = trackConversationAgentLoop(
      Promise.reject(new Error("loop failed")),
    );

    await expect(tracked).rejects.toThrow("loop failed");
    expect(activeConversationAgentLoopCount()).toBe(0);
  });
});
