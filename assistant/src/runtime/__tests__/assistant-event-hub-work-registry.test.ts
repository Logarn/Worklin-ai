import { describe, expect, test } from "bun:test";

import {
  activeAssistantEventHubWorkCount,
  assistantEventHub,
  broadcastMessage,
} from "../assistant-event-hub.js";

describe("assistant event hub work registry", () => {
  test("counts subscriber work until the publish promise actually settles", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: () => blocked,
    });

    try {
      broadcastMessage({
        type: "sync_changed",
        tags: ["resource:pooled-quiescence-test"],
      });

      expect(activeAssistantEventHubWorkCount()).toBeGreaterThan(0);
      release();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(activeAssistantEventHubWorkCount()).toBe(0);
    } finally {
      release();
      subscription.dispose();
    }
  });

  test("tenant-boundary disposal evicts every live subscriber", () => {
    let evicted = false;
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: () => {},
      onEvict: () => {
        evicted = true;
      },
    });

    expect(assistantEventHub.disposeAllSubscribers()).toBe(1);
    expect(subscription.active).toBe(false);
    expect(evicted).toBe(true);
    expect(assistantEventHub.subscriberCount()).toBe(0);
  });
});
