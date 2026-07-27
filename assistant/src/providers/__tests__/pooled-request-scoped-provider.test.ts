import { describe, expect, test } from "bun:test";

import {
  PooledRequestScopedProvider,
  type tryResolveProviderForConnectionName,
} from "../connection-resolution.js";
import type { ProvidersConfig } from "../registry.js";
import type { Provider } from "../types.js";

function provider(label: string): Provider {
  return {
    name: "openai",
    async sendMessage() {
      return {
        content: [{ type: "text", text: label }],
        model: "gpt-test",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

describe("pooled request-scoped provider", () => {
  test("resolves a fresh key-bearing adapter for every provider call", async () => {
    let resolutionCount = 0;
    const resolver: typeof tryResolveProviderForConnectionName = async () => {
      resolutionCount += 1;
      return provider(`adapter-${resolutionCount}`);
    };
    const scoped = new PooledRequestScopedProvider(
      "openai",
      "openai-personal",
      "gpt-test",
      {} as ProvidersConfig,
      resolver,
    );

    const first = await scoped.sendMessage([]);
    const second = await scoped.sendMessage([]);

    expect(first.content).toEqual([{ type: "text", text: "adapter-1" }]);
    expect(second.content).toEqual([{ type: "text", text: "adapter-2" }]);
    expect(resolutionCount).toBe(2);
  });

  test("fails closed instead of retaining an earlier adapter", async () => {
    let available = true;
    const resolver: typeof tryResolveProviderForConnectionName = async () => {
      if (!available) return null;
      available = false;
      return provider("first-request");
    };
    const scoped = new PooledRequestScopedProvider(
      "openai",
      "openai-personal",
      "gpt-test",
      {} as ProvidersConfig,
      resolver,
    );

    expect((await scoped.sendMessage([])).content).toEqual([
      { type: "text", text: "first-request" },
    ]);
    await expect(scoped.sendMessage([])).rejects.toThrow(
      'Provider "openai" is not available for this pooled request.',
    );
  });
});
