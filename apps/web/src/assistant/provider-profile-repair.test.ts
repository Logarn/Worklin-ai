import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ConfigGetResponse,
  ProviderConnection,
} from "@/generated/daemon/types.gen";
import * as sdkGen from "@/generated/daemon/sdk.gen";

interface ConfigGetCall {
  path: { assistant_id: string };
}

interface ConfigPatchCall {
  path: { assistant_id: string };
  body: Record<string, unknown>;
}

interface ConnectionsGetCall {
  path: { assistant_id: string };
}

let configGetData: ConfigGetResponse;
let connections: ProviderConnection[] = [];
let configGetCalls: ConfigGetCall[] = [];
let configPatchCalls: ConfigPatchCall[] = [];
let connectionsGetCalls: ConnectionsGetCall[] = [];

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  configGet: (opts: ConfigGetCall) => {
    configGetCalls.push(opts);
    return Promise.resolve({ data: configGetData, response: { ok: true } });
  },
  configPatch: (opts: ConfigPatchCall) => {
    configPatchCalls.push(opts);
    return Promise.resolve({ data: configGetData, response: { ok: true } });
  },
  inferenceProviderconnectionsGet: (opts: ConnectionsGetCall) => {
    connectionsGetCalls.push(opts);
    return Promise.resolve({
      data: { connections },
      response: { ok: true },
    });
  },
}));

const { ensureRunnableProfileFromStoredConnection } = await import(
  "@/assistant/provider-profile-repair"
);

const ASSISTANT_ID = "asst-1";

function makeConnection({
  name,
  provider,
  auth,
  isManaged = false,
}: {
  name: string;
  provider: ProviderConnection["provider"];
  auth: ProviderConnection["auth"];
  isManaged?: boolean;
}): ProviderConnection {
  return {
    name,
    provider,
    auth,
    label: null,
    baseUrl: null,
    models: null,
    createdAt: 0,
    updatedAt: 0,
    isManaged,
  };
}

function platformConnection(
  name: string,
  provider: ProviderConnection["provider"],
): ProviderConnection {
  return makeConnection({
    name,
    provider,
    auth: { type: "platform" },
    isManaged: true,
  });
}

function apiKeyConnection(
  name: string,
  provider: ProviderConnection["provider"],
): ProviderConnection {
  return makeConnection({
    name,
    provider,
    auth: { type: "api_key", credential: `credential/${provider}/api_key` },
  });
}

beforeEach(() => {
  configGetCalls = [];
  configPatchCalls = [];
  connectionsGetCalls = [];
  connections = [];
  configGetData = {
    llm: {
      activeProfile: "balanced",
      profileOrder: ["balanced"],
      profiles: {
        balanced: {
          source: "managed",
          label: "Balanced",
          provider: "anthropic",
          model: "claude-opus-4-8",
        },
      },
    },
  };
});

describe("ensureRunnableProfileFromStoredConnection", () => {
  test("ignores managed seed connections when exactly one API-key connection can answer", async () => {
    connections = [
      platformConnection("anthropic-managed", "anthropic"),
      platformConnection("openai-managed", "openai"),
      platformConnection("gemini-managed", "gemini"),
      platformConnection("fireworks-managed", "fireworks"),
      apiKeyConnection("anthropic-personal", "anthropic"),
    ];

    const result = await ensureRunnableProfileFromStoredConnection(ASSISTANT_ID);

    expect(result.repaired).toBe(true);
    expect(connectionsGetCalls[0].path.assistant_id).toBe(ASSISTANT_ID);
    expect(configGetCalls[0].path.assistant_id).toBe(ASSISTANT_ID);
    expect(configPatchCalls).toHaveLength(1);
    expect(configPatchCalls[0].body).toMatchObject({
      llm: {
        activeProfile: "custom-balanced",
        profileOrder: ["balanced", "custom-balanced"],
        profiles: {
          "custom-balanced": {
            source: "user",
            label: "Balanced",
            provider: "anthropic",
            provider_connection: "anthropic-personal",
          },
        },
      },
    });
  });

  test("prefers the only Kimi API-key connection over other user API-key providers", async () => {
    connections = [
      platformConnection("anthropic-managed", "anthropic"),
      apiKeyConnection("openai-personal", "openai"),
      apiKeyConnection("kimi-personal", "kimi"),
    ];

    const result = await ensureRunnableProfileFromStoredConnection(ASSISTANT_ID);

    expect(result.repaired).toBe(true);
    expect(configPatchCalls).toHaveLength(1);
    expect(configPatchCalls[0].body).toMatchObject({
      llm: {
        activeProfile: "custom-balanced",
        profiles: {
          "custom-balanced": {
            source: "user",
            label: "Balanced",
            provider: "kimi",
            provider_connection: "kimi-personal",
            model: "kimi-k2.6",
          },
        },
      },
    });
  });

  test("stays ambiguous when multiple non-managed API-key providers are equally eligible", async () => {
    connections = [
      platformConnection("anthropic-managed", "anthropic"),
      apiKeyConnection("anthropic-personal", "anthropic"),
      apiKeyConnection("openai-personal", "openai"),
    ];

    const result = await ensureRunnableProfileFromStoredConnection(ASSISTANT_ID);

    expect(result).toEqual({ repaired: false, reason: "ambiguous" });
    expect(configPatchCalls).toHaveLength(0);
  });
});
