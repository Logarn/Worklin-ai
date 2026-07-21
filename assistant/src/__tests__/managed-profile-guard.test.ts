/**
 * Tests that managed inference profiles ("quality-optimized", "balanced",
 * "cost-optimized") cannot be edited via the PUT profile route or deleted
 * via the PATCH config route.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

let savedRaw: Record<string, unknown> | null = null;
let rawConfig: Record<string, unknown>;
let listedConnections: Array<Record<string, unknown>> = [];

function makeDefaultRawConfig(): Record<string, unknown> {
  return {
    llm: {
      profiles: {
        "quality-optimized": {
          provider: "anthropic",
          model: "claude-sonnet",
        },
        balanced: { provider: "anthropic", model: "claude-sonnet" },
        "cost-optimized": { provider: "anthropic", model: "claude-haiku" },
        "my-custom": { provider: "openai", model: "gpt-4o" },
      },
    },
  };
}

function deepMergeForTest(
  target: Record<string, unknown>,
  overrides: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      target[key] !== null &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      deepMergeForTest(
        target[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
      continue;
    }
    target[key] = value;
  }
}

mock.module("../config/loader.js", () => ({
  loadRawConfig: () => structuredClone(rawConfig),
  saveRawConfig: (raw: Record<string, unknown>) => {
    savedRaw = raw;
  },
  deepMergeOverwrite: (
    target: Record<string, unknown>,
    overrides: Record<string, unknown>,
  ) => {
    deepMergeForTest(target, overrides);
  },
  getConfig: () => rawConfig,
  getDeploymentContextDefaults: () => ({}),
  invalidateConfigCache: () => {},
  withSuppressedConfigDiskWrites: async (fn: () => unknown) => fn(),
  withSuppressedConfigDiskWritesSync: (fn: () => unknown) => fn(),
}));

mock.module("../providers/registry.js", () => ({
  initializeProviders: async () => {},
}));

mock.module("../memory/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => {},
}));

// The replace-profile handler auto-derives `provider_connection` from the
// first active connection matching the requested provider when the body
// omits it. That path queries the `provider_connections` table, which the
// test doesn't migrate — stub it out so the guard logic stays the focus.
mock.module("../providers/inference/connections.js", () => ({
  listConnections: () => listedConnections,
  createConnection: () => ({ ok: false, error: { code: "already_exists" } }),
  PROVIDERS_REQUIRING_BASE_URL_AND_MODELS: new Set(["openai-compatible"]),
}));

import { ROUTES } from "../runtime/routes/conversation-query-routes.js";
import { BadRequestError, ConflictError } from "../runtime/routes/errors.js";

const replaceRoute = ROUTES.find(
  (r) => r.operationId === "config_llm_profiles_replace",
)!;

const patchRoute = ROUTES.find((r) => r.operationId === "config_patch")!;

beforeEach(() => {
  rawConfig = makeDefaultRawConfig();
  savedRaw = null;
  listedConnections = [];
});

// ---------------------------------------------------------------------------
// PUT /v1/config/llm/profiles/:name — replace inference profile
// ---------------------------------------------------------------------------

describe("PUT /v1/config/llm/profiles/:name — managed profile guard", () => {
  test("rejects edits to quality-optimized that touch non-label/status fields", async () => {
    await expect(
      replaceRoute.handler({
        pathParams: { name: "quality-optimized" },
        body: { provider: "openai", model: "gpt-4o" },
      }),
    ).rejects.toThrow(
      'Cannot edit managed profile "quality-optimized" fields [provider, model]. ' +
        "Only label and status may be edited; duplicate to a custom profile to change other fields.",
    );
  });

  test("rejects edits to balanced", async () => {
    await expect(
      replaceRoute.handler({
        pathParams: { name: "balanced" },
        body: { provider: "openai", model: "gpt-4o" },
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("rejects edits to cost-optimized", async () => {
    await expect(
      replaceRoute.handler({
        pathParams: { name: "cost-optimized" },
        body: { provider: "openai", model: "gpt-4o" },
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("allows edits to custom-balanced (user-owned)", async () => {
    savedRaw = null;
    const result = await replaceRoute.handler({
      pathParams: { name: "custom-balanced" },
      body: { provider: "openai", model: "gpt-4o" },
    });
    expect(result).toEqual({ ok: true });
    expect(savedRaw).not.toBeNull();
  });

  test("allows edits to a user-defined profile", async () => {
    savedRaw = null;
    const result = await replaceRoute.handler({
      pathParams: { name: "my-custom" },
      body: { provider: "openai", model: "gpt-4o" },
    });
    expect(result).toEqual({ ok: true });
    expect(savedRaw).not.toBeNull();
  });

  test("an unpinned user profile selects only a compatible personal connection", async () => {
    listedConnections = [
      {
        name: "openai-managed",
        provider: "openai",
        auth: { type: "platform" },
        isManaged: true,
      },
      {
        name: "chatgpt-subscription",
        provider: "openai",
        auth: {
          type: "oauth_subscription",
          credential: "credential/chatgpt/access_token",
        },
        isManaged: false,
      },
      {
        name: "openai-personal",
        provider: "openai",
        auth: {
          type: "api_key",
          credential: "credential/openai/api_key",
        },
        isManaged: false,
      },
    ];

    await replaceRoute.handler({
      pathParams: { name: "my-custom" },
      body: { source: "user", provider: "openai", model: "gpt-4o" },
    });

    expect(
      (savedRaw as unknown as Record<string, any>).llm.profiles["my-custom"]
        .provider_connection,
    ).toBe("openai-personal");
  });

  test("never auto-selects managed or model-incompatible subscription transport", async () => {
    listedConnections = [
      {
        name: "openai-managed",
        provider: "openai",
        auth: { type: "platform" },
        isManaged: true,
      },
      {
        name: "chatgpt-subscription",
        provider: "openai",
        auth: {
          type: "oauth_subscription",
          credential: "credential/chatgpt/access_token",
        },
        isManaged: false,
      },
    ];

    await replaceRoute.handler({
      pathParams: { name: "my-custom" },
      body: { source: "user", provider: "openai", model: "gpt-4o" },
    });

    expect(
      (savedRaw as unknown as Record<string, any>).llm.profiles["my-custom"],
    ).not.toHaveProperty("provider_connection");
  });

  // -------------------------------------------------------------------------
  // Null-as-clear sentinel: clients send `{ label: null }` or
  // `{ status: null }` to clear a managed profile's overrides back to the
  // seed defaults. The Zod `ProfileEntry` schema accepts null for both
  // fields, and the managed-profile guard / `patchManagedProfileFields`
  // propagate the clear through to disk. These tests lock the round-trip.
  // -------------------------------------------------------------------------

  test("PUT { label: null } on managed profile clears the label on disk", async () => {
    savedRaw = null;
    rawConfig = {
      llm: {
        profiles: {
          balanced: {
            provider: "anthropic",
            model: "claude-sonnet",
            label: "My Custom Name",
            source: "managed",
          },
        },
      },
    };
    const result = await replaceRoute.handler({
      pathParams: { name: "balanced" },
      body: { label: null },
    });
    expect(result).toEqual({ ok: true });
    const profile = (savedRaw as unknown as Record<string, any>)?.llm?.profiles
      ?.balanced as Record<string, unknown>;
    // Label key removed; seed fields preserved.
    expect("label" in profile).toBe(false);
    expect(profile.provider).toBe("anthropic");
    expect(profile.model).toBe("claude-sonnet");
    expect(profile.source).toBe("managed");
  });

  test("PUT { status: null } on managed profile clears status (back to active-by-absence)", async () => {
    savedRaw = null;
    rawConfig = {
      llm: {
        profiles: {
          "quality-optimized": {
            provider: "anthropic",
            model: "claude-opus",
            status: "disabled",
            source: "managed",
          },
        },
      },
    };
    const result = await replaceRoute.handler({
      pathParams: { name: "quality-optimized" },
      body: { status: null },
    });
    expect(result).toEqual({ ok: true });
    const profile = (savedRaw as unknown as Record<string, any>)?.llm
      ?.profiles?.["quality-optimized"] as Record<string, unknown>;
    expect("status" in profile).toBe(false);
    expect(profile.provider).toBe("anthropic");
    expect(profile.model).toBe("claude-opus");
  });

  test("PUT { label: null, status: null } clears both in a single request", async () => {
    savedRaw = null;
    rawConfig = {
      llm: {
        profiles: {
          "cost-optimized": {
            provider: "anthropic",
            model: "claude-haiku",
            label: "Speed (Custom)",
            status: "disabled",
            source: "managed",
          },
        },
      },
    };
    const result = await replaceRoute.handler({
      pathParams: { name: "cost-optimized" },
      body: { label: null, status: null },
    });
    expect(result).toEqual({ ok: true });
    const profile = (savedRaw as unknown as Record<string, any>)?.llm
      ?.profiles?.["cost-optimized"] as Record<string, unknown>;
    expect("label" in profile).toBe(false);
    expect(profile.status).toBeUndefined();
    expect(profile.provider).toBe("anthropic");
    expect(profile.model).toBe("claude-haiku");
  });

  test("PUT { label: null, status: 'disabled' } mixes clear + set in one call", async () => {
    savedRaw = null;
    rawConfig = {
      llm: {
        profiles: {
          balanced: {
            provider: "anthropic",
            model: "claude-sonnet",
            label: "Custom Label",
            source: "managed",
          },
        },
      },
    };
    const result = await replaceRoute.handler({
      pathParams: { name: "balanced" },
      body: { label: null, status: "disabled" },
    });
    expect(result).toEqual({ ok: true });
    const profile = (savedRaw as unknown as Record<string, any>)?.llm?.profiles
      ?.balanced as Record<string, unknown>;
    expect("label" in profile).toBe(false);
    expect(profile.status).toBe("disabled");
  });

  test("PUT { label: '' } on managed profile still rejected by `.min(1)`", async () => {
    // `.nullable()` only widens the type to accept null — empty strings
    // still fail the min-length check, which is correct: an empty string
    // would persist as a literal "" override, not the clear-to-seed
    // intent. Clients must send `null` to clear.
    await expect(
      replaceRoute.handler({
        pathParams: { name: "balanced" },
        body: { label: "" },
      }),
    ).rejects.toThrow(BadRequestError);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/config — managed profile deletion guard
// ---------------------------------------------------------------------------

describe("PATCH /v1/config — managed profile deletion guard", () => {
  test("rejects a stale expectedActiveProfile without writing", async () => {
    (rawConfig.llm as Record<string, unknown>).activeProfile = "balanced";

    await expect(
      patchRoute.handler({
        body: {
          expectedActiveProfile: "cost-optimized",
          llm: { activeProfile: "my-custom" },
        },
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(savedRaw).toBeNull();
  });

  test("writes a matching compare-and-swap patch without persisting the precondition", async () => {
    (rawConfig.llm as Record<string, unknown>).activeProfile = "balanced";

    await patchRoute.handler({
      body: {
        expectedActiveProfile: "balanced",
        expectedActiveProfileDecision: {
          profile: "balanced",
          provider: "anthropic",
          model: "claude-sonnet",
          provider_connection: null,
        },
        expectedProfileOrder: [],
        expectedCallSites: { conversationTitle: null },
        llm: { activeProfile: "my-custom" },
      },
    });

    expect(savedRaw).not.toHaveProperty("expectedActiveProfile");
    expect(savedRaw).not.toHaveProperty("expectedActiveProfileDecision");
    expect(savedRaw).not.toHaveProperty("expectedProfileOrder");
    expect(savedRaw).not.toHaveProperty("expectedCallSites");
    expect((savedRaw?.llm as Record<string, unknown>).activeProfile).toBe(
      "my-custom",
    );
  });

  test("rejects a stale provider decision even when the profile name still matches", async () => {
    (rawConfig.llm as Record<string, unknown>).activeProfile = "balanced";
    (
      (rawConfig.llm as Record<string, any>).profiles.balanced as Record<
        string,
        unknown
      >
    ).model = "claude-opus-newer";

    await expect(
      patchRoute.handler({
        body: {
          expectedActiveProfile: "balanced",
          expectedActiveProfileDecision: {
            profile: "balanced",
            provider: "anthropic",
            model: "claude-sonnet",
            provider_connection: null,
          },
          llm: {
            profiles: {
              balanced: { provider_connection: "anthropic-personal" },
            },
          },
        },
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(savedRaw).toBeNull();
  });

  test("rejects a stale profile order even when the active decision still matches", async () => {
    const llm = rawConfig.llm as Record<string, unknown>;
    llm.activeProfile = "balanced";
    llm.profileOrder = ["balanced", "my-custom"];

    await expect(
      patchRoute.handler({
        body: {
          expectedActiveProfile: "balanced",
          expectedActiveProfileDecision: {
            profile: "balanced",
            provider: "anthropic",
            model: "claude-sonnet",
            provider_connection: null,
          },
          expectedProfileOrder: ["balanced"],
          llm: {
            activeProfile: "my-custom",
            profileOrder: ["balanced", "new-personal-profile"],
          },
        },
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(savedRaw).toBeNull();
  });

  test("rejects a stale patched call site even when the active decision still matches", async () => {
    const llm = rawConfig.llm as Record<string, unknown>;
    llm.activeProfile = "balanced";
    llm.callSites = {
      conversationTitle: { profile: "my-custom" },
    };

    await expect(
      patchRoute.handler({
        body: {
          expectedActiveProfile: "balanced",
          expectedActiveProfileDecision: {
            profile: "balanced",
            provider: "anthropic",
            model: "claude-sonnet",
            provider_connection: null,
          },
          expectedCallSites: {
            conversationTitle: { profile: "balanced" },
          },
          llm: {
            activeProfile: "my-custom",
            callSites: {
              conversationTitle: { profile: "my-custom" },
            },
          },
        },
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(savedRaw).toBeNull();
  });

  test("rejects deletion of quality-optimized via null with descriptive message", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { "quality-optimized": null } } },
      }),
    ).rejects.toThrow('Cannot delete managed profile "quality-optimized".');
  });

  test("rejects deletion of balanced via null", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { balanced: null } } },
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("rejects deletion of cost-optimized via null", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: { "cost-optimized": null } } },
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("allows deletion of custom-balanced via null (user-owned)", async () => {
    savedRaw = null;
    const result = await patchRoute.handler({
      body: { llm: { profiles: { "custom-balanced": null } } },
    });
    expect(result).toHaveProperty("llm");
  });

  test("allows deletion of a user-defined profile via null", async () => {
    savedRaw = null;
    const result = await patchRoute.handler({
      body: { llm: { profiles: { "my-custom": null } } },
    });
    expect(result).toHaveProperty("llm");
  });

  test("allows non-profile config patches", async () => {
    const result = await patchRoute.handler({
      body: { someOtherKey: "value" },
    });
    expect(result).toHaveProperty("llm");
  });

  test("clears stale Velay ownership when manually patching public base URL", async () => {
    rawConfig = {
      ingress: {
        publicBaseUrl: "https://stale-velay.example.test",
        publicBaseUrlManagedBy: "velay",
      },
    };

    const result = await patchRoute.handler({
      body: {
        ingress: { publicBaseUrl: "https://manual.example.test" },
      },
    });

    expect(result).toHaveProperty("ingress");
    expect(savedRaw).toEqual({
      ingress: {
        publicBaseUrl: "https://manual.example.test",
        publicBaseUrlManagedBy: "velay",
      },
    });
  });

  test("allows patches that modify a managed profile (non-null)", async () => {
    savedRaw = null;
    const result = await patchRoute.handler({
      body: {
        llm: {
          profiles: { "quality-optimized": { provider: "anthropic" } },
        },
      },
    });
    expect(result).toHaveProperty("llm");
  });

  test("rejects nulling the entire profiles map", async () => {
    await expect(
      patchRoute.handler({
        body: { llm: { profiles: null } },
      }),
    ).rejects.toThrow("Cannot null llm.profiles");
  });
});
