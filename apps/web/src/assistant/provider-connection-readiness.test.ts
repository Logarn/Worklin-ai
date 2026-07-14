import { describe, expect, test } from "bun:test";

import {
  isPersonalProviderConnection,
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

  test("accepts keyless local connections without secret metadata", () => {
    expect(isProviderConnectionReady(connection({ type: "none" }), [])).toBe(
      true,
    );
  });
});
