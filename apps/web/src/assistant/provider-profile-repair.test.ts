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
let secrets: Array<{
  type: "api_key" | "credential";
  name: string;
}> = [];
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
  secretsGet: () =>
    Promise.resolve({
      data: { secrets, accounts: secrets },
      response: { ok: true },
    }),
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
  createdAt = 0,
  updatedAt = 0,
}: {
  name: string;
  provider: ProviderConnection["provider"];
  auth: ProviderConnection["auth"];
  isManaged?: boolean;
  createdAt?: number;
  updatedAt?: number;
}): ProviderConnection {
  return {
    name,
    provider,
    auth,
    label: null,
    baseUrl: null,
    models: null,
    createdAt,
    updatedAt,
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
  timestamps: { createdAt?: number; updatedAt?: number } = {},
): ProviderConnection {
  return makeConnection({
    name,
    provider,
    auth: { type: "api_key", credential: `credential/${provider}/api_key` },
    ...timestamps,
  });
}

function oauthSubscriptionConnection(
  timestamps: { createdAt?: number; updatedAt?: number } = {},
): ProviderConnection {
  return makeConnection({
    name: "chatgpt-subscription",
    provider: "openai",
    auth: {
      type: "oauth_subscription",
      credential: "credential/chatgpt/access_token",
    },
    ...timestamps,
  });
}

beforeEach(() => {
  configGetCalls = [];
  configPatchCalls = [];
  connectionsGetCalls = [];
  connections = [];
  secrets = [];
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
    secrets = [{ type: "api_key", name: "anthropic" }];
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

  test("prefers the most recently changed user provider over older user providers", async () => {
    secrets = [
      { type: "api_key", name: "openai" },
      { type: "api_key", name: "gemini" },
    ];
    connections = [
      platformConnection("anthropic-managed", "anthropic"),
      apiKeyConnection("openai-personal", "openai", {
        createdAt: 10,
        updatedAt: 10,
      }),
      apiKeyConnection("gemini-personal", "gemini", {
        createdAt: 20,
        updatedAt: 30,
      }),
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
            provider: "gemini",
            provider_connection: "gemini-personal",
            model: "gemini-2.5-flash",
          },
        },
      },
    });
  });

  test("uses a ChatGPT subscription model when activating OAuth subscription auth", async () => {
    secrets = [
      { type: "api_key", name: "openai" },
      { type: "credential", name: "chatgpt:access_token" },
    ];
    connections = [
      platformConnection("openai-managed", "openai"),
      apiKeyConnection("openai-personal", "openai", {
        createdAt: 10,
        updatedAt: 10,
      }),
      oauthSubscriptionConnection({
        createdAt: 20,
        updatedAt: 30,
      }),
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
            provider: "openai",
            provider_connection: "chatgpt-subscription",
            model: "gpt-5.4-mini",
          },
        },
      },
    });
  });

  test("uses the daemon default model when activating a keyless Ollama connection", async () => {
    connections = [
      platformConnection("anthropic-managed", "anthropic"),
      makeConnection({
        name: "ollama-local",
        provider: "ollama",
        auth: { type: "none" },
      }),
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
            provider: "ollama",
            provider_connection: "ollama-local",
            model: "llama3.2",
          },
        },
      },
    });
  });

  test("stays ambiguous when multiple non-managed API-key providers are equally eligible", async () => {
    secrets = [
      { type: "api_key", name: "anthropic" },
      { type: "api_key", name: "openai" },
    ];
    connections = [
      platformConnection("anthropic-managed", "anthropic"),
      apiKeyConnection("anthropic-personal", "anthropic"),
      apiKeyConnection("openai-personal", "openai"),
    ];

    const result = await ensureRunnableProfileFromStoredConnection(ASSISTANT_ID);

    expect(result).toEqual({ repaired: false, reason: "ambiguous" });
    expect(configPatchCalls).toHaveLength(0);
  });

  test("does not activate a personal connection whose credential is missing", async () => {
    connections = [
      platformConnection("anthropic-managed", "anthropic"),
      apiKeyConnection("anthropic-personal", "anthropic"),
    ];

    const result = await ensureRunnableProfileFromStoredConnection(ASSISTANT_ID);

    expect(result).toEqual({ repaired: false, reason: "ambiguous" });
    expect(configGetCalls).toHaveLength(0);
    expect(configPatchCalls).toHaveLength(0);
  });
});
