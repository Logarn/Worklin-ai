import { describe, expect, test } from "bun:test";

import { ProviderError } from "../../util/errors.js";
import { RetryProvider } from "../retry.js";
import type { Message, Provider, ProviderResponse } from "../types.js";

const messages: Message[] = [
  { role: "user", content: [{ type: "text", text: "one attempt" }] },
];

describe("RetryProvider resumable jobs", () => {
  test("does not retry a 429 when the caller owns resumable state", async () => {
    let attempts = 0;
    const inner: Provider = {
      name: "openai",
      async sendMessage(): Promise<ProviderResponse> {
        attempts += 1;
        throw new ProviderError("quota reached", "openai", 429);
      },
    };

    const provider = new RetryProvider(inner);
    await expect(
      provider.sendMessage(messages, { config: { retryMode: "none" } }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(attempts).toBe(1);
  });
});
