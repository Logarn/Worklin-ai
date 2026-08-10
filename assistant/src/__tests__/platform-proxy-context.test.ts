import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";

// Mock logger to suppress output
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mutable state for env and secure key stubs
let mockPlatformBaseUrl = "";
let mockAssistantApiKey: string | null = null;
const originalAssistantApiKey = process.env.ASSISTANT_API_KEY;
const originalRuntimeMode = process.env.WORKLIN_RUNTIME_MODE;
const originalPlatformAssistantId = process.env.WORKLIN_PLATFORM_ASSISTANT_ID;
const originalActorTokenSigningKey = process.env.ACTOR_TOKEN_SIGNING_KEY;
const originalConcurrentProvider =
  process.env.CONCURRENT_RUNTIME_MANAGED_PROVIDER;
const originalConcurrentModel = process.env.CONCURRENT_RUNTIME_MANAGED_MODEL;
const originalMoonshotApiKey = process.env.MOONSHOT_API_KEY;

afterAll(() => {
  if (originalAssistantApiKey === undefined) {
    delete process.env.ASSISTANT_API_KEY;
  } else {
    process.env.ASSISTANT_API_KEY = originalAssistantApiKey;
  }
  if (originalRuntimeMode === undefined) {
    delete process.env.WORKLIN_RUNTIME_MODE;
  } else {
    process.env.WORKLIN_RUNTIME_MODE = originalRuntimeMode;
  }
  if (originalPlatformAssistantId === undefined) {
    delete process.env.WORKLIN_PLATFORM_ASSISTANT_ID;
  } else {
    process.env.WORKLIN_PLATFORM_ASSISTANT_ID = originalPlatformAssistantId;
  }
  if (originalActorTokenSigningKey === undefined) {
    delete process.env.ACTOR_TOKEN_SIGNING_KEY;
  } else {
    process.env.ACTOR_TOKEN_SIGNING_KEY = originalActorTokenSigningKey;
  }
  if (originalConcurrentProvider === undefined) {
    delete process.env.CONCURRENT_RUNTIME_MANAGED_PROVIDER;
  } else {
    process.env.CONCURRENT_RUNTIME_MANAGED_PROVIDER =
      originalConcurrentProvider;
  }
  if (originalConcurrentModel === undefined) {
    delete process.env.CONCURRENT_RUNTIME_MANAGED_MODEL;
  } else {
    process.env.CONCURRENT_RUNTIME_MANAGED_MODEL = originalConcurrentModel;
  }
  if (originalMoonshotApiKey === undefined) {
    delete process.env.MOONSHOT_API_KEY;
  } else {
    process.env.MOONSHOT_API_KEY = originalMoonshotApiKey;
  }
});

beforeEach(() => {
  delete process.env.ASSISTANT_API_KEY;
  delete process.env.WORKLIN_RUNTIME_MODE;
  delete process.env.WORKLIN_PLATFORM_ASSISTANT_ID;
  delete process.env.ACTOR_TOKEN_SIGNING_KEY;
  delete process.env.CONCURRENT_RUNTIME_MANAGED_PROVIDER;
  delete process.env.CONCURRENT_RUNTIME_MANAGED_MODEL;
  delete process.env.MOONSHOT_API_KEY;
});

mock.module("../config/env.js", () => ({
  getPlatformBaseUrl: () => mockPlatformBaseUrl,
  isConcurrentServiceRuntime: () =>
    process.env.WORKLIN_RUNTIME_MODE?.trim().toLowerCase() ===
    "concurrent_service",
  isPooledWorkerRuntime: () => false,
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => {
    if (key === credentialKey("vellum", "assistant_api_key")) {
      return mockAssistantApiKey;
    }
    return null;
  },
}));

import { runWithConcurrentManagedProviderContext } from "../providers/platform-proxy/concurrent-request-context.js";
import {
  buildManagedBaseUrl,
  hasManagedProxyPrereqs,
  managedFallbackEnabledFor,
  resolveManagedProxyContext,
} from "../providers/platform-proxy/context.js";
import { getConfiguredProvider } from "../providers/provider-send-message.js";

function concurrentContext(assistantId: string, requestId: string) {
  return {
    version: 1 as const,
    organizationId: "org-abc",
    userId: "user-123",
    assistantId,
    actorId: "actor-123",
    requestId,
    authorizationVersion: 1,
    configVersion: 1,
    runtimeGeneration: 1,
  };
}

describe("resolveManagedProxyContext", () => {
  beforeEach(() => {
    mockPlatformBaseUrl = "";
    mockAssistantApiKey = null;
    delete process.env.ASSISTANT_API_KEY;
    delete process.env.WORKLIN_RUNTIME_MODE;
    delete process.env.WORKLIN_PLATFORM_ASSISTANT_ID;
    delete process.env.ACTOR_TOKEN_SIGNING_KEY;
  });

  test("returns disabled when platform URL is empty", async () => {
    mockPlatformBaseUrl = "";
    mockAssistantApiKey = "sk-test-key";

    const ctx = await resolveManagedProxyContext();
    expect(ctx.enabled).toBe(false);
    expect(ctx.platformBaseUrl).toBe("");
  });

  test("returns disabled when assistant API key is missing", async () => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = null;

    const ctx = await resolveManagedProxyContext();
    expect(ctx.enabled).toBe(false);
    expect(ctx.assistantApiKey).toBe("");
  });

  test("returns disabled when both are missing", async () => {
    const ctx = await resolveManagedProxyContext();
    expect(ctx.enabled).toBe(false);
  });

  test("returns enabled when both platform URL and API key are present", async () => {
    mockPlatformBaseUrl = "https://platform.example.com/";
    mockAssistantApiKey = "sk-test-key";

    const ctx = await resolveManagedProxyContext();
    expect(ctx.enabled).toBe(true);
    expect(ctx.platformBaseUrl).toBe("https://platform.example.com");
    expect(ctx.assistantApiKey).toBe("sk-test-key");
  });

  test("uses ASSISTANT_API_KEY env fallback when stored key is missing", async () => {
    mockPlatformBaseUrl = "https://platform.example.com/";
    mockAssistantApiKey = null;
    process.env.ASSISTANT_API_KEY = " env-key ";

    const ctx = await resolveManagedProxyContext();
    expect(ctx.enabled).toBe(true);
    expect(ctx.assistantApiKey).toBe("env-key");
  });

  test("prefers stored key over ASSISTANT_API_KEY env fallback", async () => {
    mockPlatformBaseUrl = "https://platform.example.com/";
    mockAssistantApiKey = " stored-key ";
    process.env.ASSISTANT_API_KEY = "env-key";

    const ctx = await resolveManagedProxyContext();
    expect(ctx.enabled).toBe(true);
    expect(ctx.assistantApiKey).toBe("stored-key");
  });

  test("derives a scoped key inside an existing isolated Worklin runtime", async () => {
    mockPlatformBaseUrl = "https://worklin-ai.vercel.app";
    process.env.WORKLIN_RUNTIME_MODE = "isolated";
    process.env.WORKLIN_PLATFORM_ASSISTANT_ID = "worklin-assistant-123";
    process.env.ACTOR_TOKEN_SIGNING_KEY = "ab".repeat(32);

    const ctx = await resolveManagedProxyContext();
    expect(ctx.enabled).toBe(true);
    expect(ctx.assistantApiKey).toHaveLength(64);
    expect(ctx.assistantApiKey).toBe(
      "549cfe391115ba16fa3fbde47f800751f3a3bc4dbfa260edbdc0a0d3d61f3d76",
    );
  });

  test("does not derive a key outside an isolated runtime", async () => {
    mockPlatformBaseUrl = "https://worklin-ai.vercel.app";
    process.env.WORKLIN_RUNTIME_MODE = "pooled";
    process.env.WORKLIN_PLATFORM_ASSISTANT_ID = "worklin-assistant-123";
    process.env.ACTOR_TOKEN_SIGNING_KEY = "ab".repeat(32);

    const ctx = await resolveManagedProxyContext();
    expect(ctx.enabled).toBe(false);
  });

  test("resolves a managed provider without tenant SQLite state", async () => {
    process.env.WORKLIN_RUNTIME_MODE = "concurrent_service";
    process.env.CONCURRENT_RUNTIME_MANAGED_PROVIDER = "kimi";
    process.env.CONCURRENT_RUNTIME_MANAGED_MODEL = "kimi-k2.6";
    process.env.MOONSHOT_API_KEY = "company-managed-key";

    expect(await getConfiguredProvider("mainAgent")).toBeNull();
    const provider = await runWithConcurrentManagedProviderContext(
      concurrentContext("assistant-1", "request-1"),
      () => getConfiguredProvider("mainAgent"),
    );

    expect(provider?.name).toBe("kimi");
  });

  test("fails closed when the concurrent managed key is missing", async () => {
    process.env.WORKLIN_RUNTIME_MODE = "concurrent_service";

    const provider = await runWithConcurrentManagedProviderContext(
      concurrentContext("assistant-1", "request-1"),
      () => getConfiguredProvider("mainAgent"),
    );

    expect(provider).toBeNull();
  });

  test("strips trailing slashes from platform URL", async () => {
    mockPlatformBaseUrl = "https://platform.example.com///";
    mockAssistantApiKey = "sk-test-key";

    const ctx = await resolveManagedProxyContext();
    expect(ctx.platformBaseUrl).toBe("https://platform.example.com");
  });
});

describe("hasManagedProxyPrereqs", () => {
  beforeEach(() => {
    mockPlatformBaseUrl = "";
    mockAssistantApiKey = null;
  });

  test("returns false when prerequisites are missing", async () => {
    expect(await hasManagedProxyPrereqs()).toBe(false);
  });

  test("returns true when prerequisites are satisfied", async () => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = "sk-test-key";
    expect(await hasManagedProxyPrereqs()).toBe(true);
  });
});

describe("buildManagedBaseUrl", () => {
  beforeEach(() => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = "sk-test-key";
  });

  test("builds correct URL for managed providers", async () => {
    expect(await buildManagedBaseUrl("anthropic")).toBe(
      "https://platform.example.com/v1/runtime-proxy/anthropic",
    );
    expect(await buildManagedBaseUrl("gemini")).toBe(
      "https://platform.example.com/v1/runtime-proxy/gemini",
    );
    expect(await buildManagedBaseUrl("openai")).toBe(
      "https://platform.example.com/v1/runtime-proxy/openai",
    );
  });

  test("returns managed URL for fireworks", async () => {
    expect(await buildManagedBaseUrl("fireworks")).toBe(
      "https://platform.example.com/v1/runtime-proxy/fireworks",
    );
  });

  test("returns undefined for non-managed providers", async () => {
    expect(await buildManagedBaseUrl("openrouter")).toBeUndefined();
    expect(await buildManagedBaseUrl("ollama")).toBeUndefined();
  });

  test("returns undefined for unknown provider", async () => {
    expect(await buildManagedBaseUrl("unknown-provider")).toBeUndefined();
  });

  test("returns undefined when prerequisites are missing", async () => {
    mockPlatformBaseUrl = "";
    mockAssistantApiKey = null;
    expect(await buildManagedBaseUrl("anthropic")).toBeUndefined();
    expect(await buildManagedBaseUrl("gemini")).toBeUndefined();
    expect(await buildManagedBaseUrl("openai")).toBeUndefined();
  });
});

describe("managedFallbackEnabledFor", () => {
  beforeEach(() => {
    mockPlatformBaseUrl = "https://platform.example.com";
    mockAssistantApiKey = "sk-test-key";
  });

  test("returns true only for managed fallback providers with prerequisites", async () => {
    expect(await managedFallbackEnabledFor("anthropic")).toBe(true);
    expect(await managedFallbackEnabledFor("gemini")).toBe(true);
    expect(await managedFallbackEnabledFor("openai")).toBe(true);
  });

  test("returns false for non-managed provider", async () => {
    expect(await managedFallbackEnabledFor("ollama")).toBe(false);
  });

  test("returns false for unknown provider", async () => {
    expect(await managedFallbackEnabledFor("unknown")).toBe(false);
  });

  test("returns false when prerequisites are missing", async () => {
    mockPlatformBaseUrl = "";
    mockAssistantApiKey = null;
    expect(await managedFallbackEnabledFor("anthropic")).toBe(false);
    expect(await managedFallbackEnabledFor("gemini")).toBe(false);
    expect(await managedFallbackEnabledFor("openai")).toBe(false);
  });
});
