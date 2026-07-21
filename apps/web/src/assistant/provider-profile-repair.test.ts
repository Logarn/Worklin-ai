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
let configGetResponses: ConfigGetResponse[] = [];
let connections: ProviderConnection[] = [];
let secrets: Array<{
  type: "api_key" | "credential";
  name: string;
}> = [];
let configGetCalls: ConfigGetCall[] = [];
let configPatchCalls: ConfigPatchCall[] = [];
let connectionsGetCalls: ConnectionsGetCall[] = [];
let configPatchError: unknown = null;

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  configGet: (opts: ConfigGetCall) => {
    configGetCalls.push(opts);
    return Promise.resolve({
      data: configGetResponses.shift() ?? configGetData,
      response: { ok: true },
    });
  },
  configPatch: (opts: ConfigPatchCall) => {
    configPatchCalls.push(opts);
    if (configPatchError) return Promise.reject(configPatchError);
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

const {
  buildInteractivePersonalCallSitePatch,
  buildInteractiveProfileSelectionPatch,
  canSendAfterManagedProfileRepair,
  ensureRunnableProfileForConnection,
  ensureRunnableProfileFromStoredConnection,
  repairUnavailableManagedProfile,
} = await import("@/assistant/provider-profile-repair");

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
  configGetResponses = [];
  configPatchCalls = [];
  connectionsGetCalls = [];
  configPatchError = null;
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

    const result =
      await ensureRunnableProfileFromStoredConnection(ASSISTANT_ID);

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

  test("does not guess between multiple ready user providers", async () => {
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

    const result =
      await ensureRunnableProfileFromStoredConnection(ASSISTANT_ID);

    expect(result).toEqual({
      repaired: false,
      reason: "ambiguous",
    });
    expect(configPatchCalls).toHaveLength(0);
  });

  test("uses a ChatGPT subscription model when activating OAuth subscription auth", async () => {
    secrets = [{ type: "credential", name: "chatgpt:access_token" }];
    connections = [
      platformConnection("openai-managed", "openai"),
      oauthSubscriptionConnection({
        createdAt: 20,
        updatedAt: 30,
      }),
    ];

    const result =
      await ensureRunnableProfileFromStoredConnection(ASSISTANT_ID);

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

    const result =
      await ensureRunnableProfileFromStoredConnection(ASSISTANT_ID);

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

  test("uses the connection model for an OpenAI-compatible xAI connection", async () => {
    secrets = [{ type: "credential", name: "xai:api_key" }];
    connections = [
      {
        ...makeConnection({
          name: "xai-personal",
          provider: "openai-compatible",
          auth: {
            type: "api_key",
            credential: "credential/xai/api_key",
          },
        }),
        label: "xAI",
        baseUrl: "https://api.x.ai/v1",
        models: [{ id: "grok-4.3", displayName: "Grok 4.3" }],
      },
    ];

    const result =
      await ensureRunnableProfileFromStoredConnection(ASSISTANT_ID);

    expect(result.repaired).toBe(true);
    expect(configPatchCalls[0].body).toMatchObject({
      llm: {
        activeProfile: "custom-balanced",
        profiles: {
          "custom-balanced": {
            source: "user",
            provider: "openai-compatible",
            provider_connection: "xai-personal",
            model: "grok-4.3",
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

    const result =
      await ensureRunnableProfileFromStoredConnection(ASSISTANT_ID);

    expect(result).toEqual({ repaired: false, reason: "ambiguous" });
    expect(configPatchCalls).toHaveLength(0);
  });

  test("does not activate a personal connection whose credential is missing", async () => {
    connections = [
      platformConnection("anthropic-managed", "anthropic"),
      apiKeyConnection("anthropic-personal", "anthropic"),
    ];

    const result =
      await ensureRunnableProfileFromStoredConnection(ASSISTANT_ID);

    expect(result).toEqual({ repaired: false, reason: "ambiguous" });
    expect(configGetCalls).toHaveLength(0);
    expect(configPatchCalls).toHaveLength(0);
  });
});

describe("repairUnavailableManagedProfile", () => {
  test("replaces a stale managed selection with the only ready personal connection", async () => {
    secrets = [{ type: "api_key", name: "anthropic" }];
    connections = [
      platformConnection("anthropic-managed", "anthropic"),
      apiKeyConnection("anthropic-personal", "anthropic"),
    ];

    const result = await repairUnavailableManagedProfile(ASSISTANT_ID);

    expect(result.repaired).toBe(true);
    expect(configPatchCalls).toHaveLength(1);
    expect(configPatchCalls[0].body).toMatchObject({
      expectedActiveProfile: "balanced",
      expectedActiveProfileDecision: {
        profile: "balanced",
        provider: "anthropic",
        model: "claude-opus-4-8",
        provider_connection: null,
      },
      llm: {
        activeProfile: "custom-balanced",
        callSites: {
          callAgent: { profile: "custom-balanced" },
          conversationTitle: { profile: "custom-balanced" },
          homeGreeting: { profile: "custom-balanced" },
          inference: { profile: "custom-balanced" },
          memoryExtraction: { profile: "custom-balanced" },
          subagentSpawn: { profile: "custom-balanced" },
          workflowLeaf: { profile: "custom-balanced" },
        },
        profiles: {
          "custom-balanced": {
            source: "user",
            provider_connection: "anthropic-personal",
          },
        },
      },
    });
    const callSites = (
      configPatchCalls[0].body.llm as {
        callSites: Record<string, unknown>;
      }
    ).callSites;
    expect(callSites).not.toHaveProperty("heartbeatAgent");
    expect(callSites).not.toHaveProperty("memoryRetrospective");
    expect(callSites).not.toHaveProperty("notificationDecision");
  });

  test("replaces a user profile that still points at a platform connection", async () => {
    configGetData = {
      llm: {
        activeProfile: "legacy-platform",
        profileOrder: ["legacy-platform"],
        profiles: {
          "legacy-platform": {
            source: "user",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
            model: "claude-sonnet-4-6",
          },
        },
      },
    };
    secrets = [{ type: "api_key", name: "anthropic" }];
    connections = [
      platformConnection("anthropic-managed", "anthropic"),
      apiKeyConnection("anthropic-personal", "anthropic"),
    ];

    const result = await repairUnavailableManagedProfile(ASSISTANT_ID);

    expect(result.repaired).toBe(true);
    expect(configPatchCalls[0].body).toMatchObject({
      llm: { activeProfile: "custom-balanced" },
    });
  });

  test("keeps an already runnable personal selection and repairs interactive call sites", async () => {
    configGetData = {
      llm: {
        activeProfile: "personal",
        profileOrder: ["personal"],
        profiles: {
          personal: {
            source: "user",
            provider: "anthropic",
            provider_connection: "anthropic-personal",
            model: "claude-sonnet-4-6",
          },
        },
      },
    };
    secrets = [{ type: "api_key", name: "anthropic" }];
    connections = [apiKeyConnection("anthropic-personal", "anthropic")];

    const result = await repairUnavailableManagedProfile(ASSISTANT_ID);

    expect(result).toEqual({
      repaired: true,
      providerLabel: "Anthropic",
    });
    expect(configPatchCalls).toHaveLength(1);
    expect(configPatchCalls[0].body).toMatchObject({
      expectedActiveProfile: "personal",
      llm: {
        callSites: {
          conversationTitle: { profile: "personal" },
          memoryRouter: { profile: "personal" },
          subagentSpawn: { profile: "personal" },
        },
      },
    });
    expect(configPatchCalls[0].body).not.toMatchObject({
      llm: { activeProfile: expect.anything() },
    });
  });

  test("pins a legacy unpinned personal profile to a ready connection even when an unready managed row comes first", async () => {
    configGetData = {
      llm: {
        activeProfile: "legacy-openai",
        profileOrder: ["legacy-openai"],
        profiles: {
          "legacy-openai": {
            source: "user",
            provider: "openai",
            model: "gpt-5.4",
          },
        },
      },
    };
    secrets = [{ type: "api_key", name: "openai" }];
    connections = [
      platformConnection("openai-managed", "openai"),
      apiKeyConnection("openai-personal", "openai"),
    ];

    const result = await repairUnavailableManagedProfile(ASSISTANT_ID);

    expect(result).toEqual({
      repaired: true,
      providerLabel: "OpenAI",
    });
    expect(configPatchCalls).toHaveLength(1);
    expect(configPatchCalls[0].body).toMatchObject({
      expectedActiveProfile: "legacy-openai",
      llm: {
        profiles: {
          "legacy-openai": {
            provider_connection: "openai-personal",
          },
        },
        callSites: {
          conversationTitle: { profile: "legacy-openai" },
          subagentSpawn: { profile: "legacy-openai" },
        },
      },
    });
  });

  test("does not call an incompatible unpinned ChatGPT subscription profile runnable", async () => {
    configGetData = {
      llm: {
        activeProfile: "legacy-openai",
        profileOrder: ["legacy-openai"],
        profiles: {
          "legacy-openai": {
            source: "user",
            provider: "openai",
            model: "gpt-5.4-nano",
          },
        },
      },
    };
    secrets = [{ type: "credential", name: "chatgpt:access_token" }];
    connections = [oauthSubscriptionConnection()];

    const result = await repairUnavailableManagedProfile(ASSISTANT_ID);

    expect(result).toEqual({
      repaired: false,
      reason: "selection-changed",
    });
    expect(configPatchCalls).toHaveLength(0);
  });

  test("does not treat a personal profile with a missing credential as runnable", async () => {
    configGetData = {
      llm: {
        activeProfile: "personal",
        profileOrder: ["personal"],
        profiles: {
          personal: {
            source: "user",
            provider: "anthropic",
            provider_connection: "anthropic-personal",
            model: "claude-sonnet-4-6",
          },
        },
      },
    };
    connections = [apiKeyConnection("anthropic-personal", "anthropic")];

    const result = await repairUnavailableManagedProfile(ASSISTANT_ID);

    expect(result).toEqual({
      repaired: false,
      reason: "selection-changed",
    });
    expect(canSendAfterManagedProfileRepair(result)).toBe(false);
    expect(configPatchCalls).toHaveLength(0);
  });

  test("does not guess when multiple personal connections are equally eligible", async () => {
    secrets = [
      { type: "api_key", name: "anthropic" },
      { type: "api_key", name: "openai" },
    ];
    connections = [
      platformConnection("anthropic-managed", "anthropic"),
      apiKeyConnection("anthropic-personal", "anthropic"),
      apiKeyConnection("openai-personal", "openai"),
    ];

    const result = await repairUnavailableManagedProfile(ASSISTANT_ID);

    expect(result).toEqual({ repaired: false, reason: "ambiguous" });
    expect(configPatchCalls).toHaveLength(0);
  });

  test("does not overwrite a provider selected while repair is in flight", async () => {
    const managedConfig = configGetData;
    const personalConfig: ConfigGetResponse = {
      llm: {
        activeProfile: "personal",
        profileOrder: ["personal"],
        profiles: {
          personal: {
            source: "user",
            provider: "anthropic",
            provider_connection: "anthropic-personal",
            model: "claude-sonnet-4-6",
          },
        },
      },
    };
    configGetResponses = [managedConfig, personalConfig];
    secrets = [{ type: "api_key", name: "anthropic" }];
    connections = [
      platformConnection("anthropic-managed", "anthropic"),
      apiKeyConnection("anthropic-personal", "anthropic"),
    ];

    const result = await repairUnavailableManagedProfile(ASSISTANT_ID);

    expect(result).toMatchObject({
      repaired: false,
      reason: "selection-changed",
    });
    expect(configPatchCalls).toHaveLength(0);
  });

  test("does not repair a different active profile than the caller checked", async () => {
    configGetData = {
      llm: {
        activeProfile: "newer-choice",
        profiles: {
          "newer-choice": {
            source: "managed",
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
        },
      },
    };

    const result = await repairUnavailableManagedProfile(
      ASSISTANT_ID,
      "older-choice",
    );

    expect(result).toEqual({ repaired: false, reason: "selection-changed" });
    expect(configPatchCalls).toHaveLength(0);
  });

  test("maps a server compare-and-swap conflict to selection-changed", async () => {
    secrets = [{ type: "api_key", name: "anthropic" }];
    connections = [
      platformConnection("anthropic-managed", "anthropic"),
      apiKeyConnection("anthropic-personal", "anthropic"),
    ];
    configPatchError = {
      error: {
        code: "CONFLICT",
        message: "The active model selection changed",
      },
    };

    const result = await repairUnavailableManagedProfile(ASSISTANT_ID);

    expect(result).toMatchObject({
      repaired: false,
      reason: "selection-changed",
    });
    expect(configPatchCalls).toHaveLength(1);
    expect(configPatchCalls[0].body).toMatchObject({
      expectedActiveProfile: "balanced",
    });
  });

  test("shares an in-flight repair for the same assistant", async () => {
    secrets = [{ type: "api_key", name: "anthropic" }];
    connections = [apiKeyConnection("anthropic-personal", "anthropic")];

    const [first, second] = await Promise.all([
      repairUnavailableManagedProfile(ASSISTANT_ID),
      repairUnavailableManagedProfile(ASSISTANT_ID),
    ]);

    expect(first.repaired).toBe(true);
    expect(second.repaired).toBe(true);
    expect(configPatchCalls).toHaveLength(1);
  });

  test("returns ambiguous for an unpinned profile with multiple ready personal candidates", async () => {
    configGetData = {
      llm: {
        activeProfile: "personal-any",
        profileOrder: ["personal-any"],
        profiles: {
          "personal-any": {
            source: "user",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        },
      },
    };
    secrets = [{ type: "api_key", name: "anthropic" }];
    connections = [
      platformConnection("anthropic-managed", "anthropic"),
      apiKeyConnection("anthropic-personal-a", "anthropic"),
      apiKeyConnection("anthropic-personal-b", "anthropic"),
    ];

    const result = await repairUnavailableManagedProfile(
      ASSISTANT_ID,
      "personal-any",
    );

    expect(result).toEqual({ repaired: false, reason: "ambiguous" });
    expect(configPatchCalls).toHaveLength(0);
  });

  test("CAS snapshots provider, model, and connection when activating a key", async () => {
    const created = apiKeyConnection("anthropic-personal", "anthropic");
    connections = [
      platformConnection("anthropic-managed", "anthropic"),
      created,
    ];

    const result = await ensureRunnableProfileForConnection(
      ASSISTANT_ID,
      created,
      {
        activateConnection: true,
        connections,
        routeInteractiveCallSites: true,
      },
    );

    expect(result.repaired).toBe(true);
    expect(configPatchCalls[0].body).toMatchObject({
      expectedActiveProfile: "balanced",
      expectedActiveProfileDecision: {
        profile: "balanced",
        provider: "anthropic",
        model: "claude-opus-4-8",
        provider_connection: null,
      },
    });
  });
});

describe("buildInteractivePersonalCallSitePatch", () => {
  test("replaces the old main profile without overwriting explicit specialist routes", () => {
    const config: ConfigGetResponse = {
      llm: {
        activeProfile: "openai",
        profileOrder: ["openai", "anthropic", "specialist", "balanced"],
        profiles: {
          openai: {
            source: "user",
            provider: "openai",
            model: "gpt-5.4",
          },
          anthropic: {
            source: "user",
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
          specialist: {
            source: "user",
            provider: "gemini",
            model: "gemini-3.1-pro-preview",
          },
          balanced: {
            source: "managed",
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
        },
        callSites: {
          conversationTitle: { profile: "openai" },
          memoryExtraction: { profile: "specialist" },
          subagentSpawn: { profile: "balanced" },
          replySuggestion: {
            provider: "openai",
            model: "gpt-5.4-mini",
          },
          heartbeatAgent: { profile: "balanced" },
        },
      },
    };

    const patch = buildInteractivePersonalCallSitePatch(
      config.llm,
      "anthropic",
      [],
      { replaceProfileName: "openai" },
    );

    expect(patch).toMatchObject({
      conversationTitle: { profile: "anthropic" },
      subagentSpawn: { profile: "anthropic" },
    });
    expect(patch).not.toHaveProperty("memoryExtraction");
    expect(patch).not.toHaveProperty("replySuggestion");
    expect(patch).not.toHaveProperty("heartbeatAgent");
  });

  test("builds one CAS-aware active-profile and interactive-routing patch", () => {
    const config: ConfigGetResponse = {
      llm: {
        activeProfile: "balanced",
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
          personal: {
            source: "user",
            provider: "openai",
            model: "gpt-5.4",
            provider_connection: "openai-personal",
          },
        },
        callSites: {
          conversationTitle: { profile: "balanced" },
          heartbeatAgent: { profile: "balanced" },
        },
      },
    };

    const patch = buildInteractiveProfileSelectionPatch(
      config.llm,
      "personal",
      "balanced",
      [],
      true,
    );

    expect(patch).toMatchObject({
      expectedActiveProfile: "balanced",
      expectedActiveProfileDecision: {
        profile: "balanced",
        provider: "anthropic",
        model: "claude-opus-4-8",
        provider_connection: null,
      },
      llm: {
        activeProfile: "personal",
        callSites: {
          conversationTitle: { profile: "personal" },
          subagentSpawn: { profile: "personal" },
        },
      },
    });
    expect(patch.llm?.callSites).not.toHaveProperty("heartbeatAgent");
  });

  test("clears direct provider/model overrides that inherit managed transport", () => {
    const managed = platformConnection("anthropic-managed", "anthropic");
    const config: ConfigGetResponse = {
      llm: {
        activeProfile: "balanced",
        profiles: {
          balanced: {
            source: "managed",
            provider: "anthropic",
            model: "claude-opus-4-8",
            provider_connection: "anthropic-managed",
          },
          personal: {
            source: "user",
            provider: "openai",
            model: "gpt-5.4",
            provider_connection: "openai-personal",
          },
        },
        callSites: {
          replySuggestion: {
            provider: "openai",
            model: "gpt-5.4-mini",
          },
        },
      },
    };

    const patch = buildInteractivePersonalCallSitePatch(
      config.llm,
      "personal",
      [managed],
    );

    expect(patch.replySuggestion).toEqual({
      profile: "personal",
      provider: null,
      model: null,
    });
  });
});

describe("canSendAfterManagedProfileRepair", () => {
  test("allows repaired or already-personal profiles and blocks unresolved setup", () => {
    expect(canSendAfterManagedProfileRepair({ repaired: true })).toBe(true);
    expect(
      canSendAfterManagedProfileRepair({
        repaired: false,
        reason: "already-runnable",
      }),
    ).toBe(true);
    expect(
      canSendAfterManagedProfileRepair({
        repaired: false,
        reason: "ambiguous",
      }),
    ).toBe(false);
  });
});
