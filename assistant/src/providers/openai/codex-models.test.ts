import { describe, expect, test } from "bun:test";

import {
  fetchCodexSubscriptionModels,
  getChatgptAccountId,
  isCodexSubscriptionModel,
} from "./codex-models.js";

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("ChatGPT subscription model catalog", () => {
  test("extracts the ChatGPT account id from OAuth claims", () => {
    const token = jwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-123",
      },
    });

    expect(getChatgptAccountId(token)).toBe("account-123");
    expect(getChatgptAccountId("not-a-jwt")).toBeNull();
  });

  test("loads visible account models in provider priority order", async () => {
    const token = jwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-123",
      },
    });
    let requestedUrl = "";
    let requestedHeaders: Headers | undefined;

    const models = await fetchCodexSubscriptionModels(token, {
      fetchImpl: async (input, init) => {
        requestedUrl = String(input);
        requestedHeaders = new Headers(init?.headers);
        return Response.json({
          models: [
            {
              slug: "gpt-hidden",
              display_name: "Hidden",
              visibility: "hide",
              priority: 0,
            },
            {
              slug: "gpt-fast",
              display_name: "GPT Fast",
              visibility: "list",
              priority: 2,
            },
            {
              slug: "gpt-best",
              display_name: "GPT Best",
              visibility: "list",
              priority: 1,
            },
            {
              slug: "gpt-best",
              display_name: "Duplicate",
              visibility: "list",
              priority: 3,
            },
          ],
        });
      },
    });

    expect(requestedUrl).toContain(
      "/backend-api/codex/models?client_version=0.160.1",
    );
    expect(requestedHeaders?.get("Authorization")).toBe(`Bearer ${token}`);
    expect(requestedHeaders?.get("ChatGPT-Account-ID")).toBe("account-123");
    expect(models).toEqual([
      { id: "gpt-best", displayName: "GPT Best" },
      { id: "gpt-fast", displayName: "GPT Fast" },
    ]);
  });

  test("uses connection models as the compatibility authority", () => {
    const models = [{ id: "account-model", displayName: "Account Model" }];

    expect(isCodexSubscriptionModel("account-model", models)).toBe(true);
    expect(isCodexSubscriptionModel("gpt-6.1-sol", models)).toBe(false);
    expect(isCodexSubscriptionModel("gpt-6.1-sol", null)).toBe(true);
  });

  test("rejects failed catalog responses without exposing the body", async () => {
    await expect(
      fetchCodexSubscriptionModels("token", {
        fetchImpl: async () => new Response("sensitive", { status: 401 }),
      }),
    ).rejects.toThrow("HTTP 401");
  });
});
