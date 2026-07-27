import { describe, expect, test } from "bun:test";

import {
  canSafelyUseAnyProviderConnection,
  isPersonalProviderConnection,
  isProviderConnectionCompatibleWithModel,
  isProviderConnectionReady,
} from "@/assistant/provider-connection-readiness";
import type { ProviderConnection } from "@/generated/daemon/types.gen";

function connection(
  auth: ProviderConnection["auth"],
  isManaged = false,
): ProviderConnection {
  return {
    name: "test-connection",
    provider: "anthropic",
    auth,
    label: null,
    baseUrl: null,
    models: null,
    createdAt: 0,
    updatedAt: 0,
    isManaged,
  };
}

describe("provider connection readiness", () => {
  test("rejects managed and platform connections as personal connections", () => {
    expect(
      isPersonalProviderConnection(connection({ type: "platform" }, true)),
    ).toBe(false);
    expect(
      isPersonalProviderConnection(
        connection(
          { type: "api_key", credential: "credential/anthropic/api_key" },
          true,
        ),
      ),
    ).toBe(false);
  });

  test("allows Any connection only when every choice is personal", () => {
    const personal = connection({
      type: "api_key",
      credential: "credential/anthropic/api_key",
    });
    const secondPersonal = { ...personal, name: "second-personal" };
    const managed = connection({ type: "platform" }, true);

    expect(
      canSafelyUseAnyProviderConnection([personal, secondPersonal]),
    ).toBe(true);
    expect(canSafelyUseAnyProviderConnection([personal, managed])).toBe(false);
    expect(canSafelyUseAnyProviderConnection([personal])).toBe(false);
  });

  test("requires matching secret metadata for credential-backed auth", () => {
    const apiKeyConnection = connection({
      type: "api_key",
      credential: "credential/anthropic/api_key",
    });

    expect(isProviderConnectionReady(apiKeyConnection, [])).toBe(false);
    expect(
      isProviderConnectionReady(apiKeyConnection, [
        { type: "api_key", name: "anthropic" },
      ]),
    ).toBe(true);
  });

  test("accepts a namespaced API key stored as credential metadata", () => {
    const xaiConnection = {
      ...connection({
        type: "api_key",
        credential: "credential/xai/api_key",
      }),
      provider: "openai-compatible",
    } as ProviderConnection;

    expect(
      isProviderConnectionReady(xaiConnection, [
        { type: "credential", name: "xai:api_key" },
      ]),
    ).toBe(true);
  });

  test("accepts keyless local connections without secret metadata", () => {
    expect(isProviderConnectionReady(connection({ type: "none" }), [])).toBe(
      true,
    );
  });

  test("matches assistant auto-resolution model compatibility for ChatGPT subscriptions", () => {
    const subscription = connection({
      type: "oauth_subscription",
      credential: "credential/chatgpt/access_token",
    });

    expect(
      isProviderConnectionCompatibleWithModel(subscription, "gpt-5.4-mini"),
    ).toBe(true);
    expect(
      isProviderConnectionCompatibleWithModel(subscription, "gpt-5.4-nano"),
    ).toBe(false);
  });
});
