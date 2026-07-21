import { afterEach, describe, expect, test } from "bun:test";

import { PROVIDER_CATALOG } from "../providers/model-catalog.js";
import { API_KEY_PROVIDERS } from "../providers/provider-secret-catalog.js";
import { SEARCH_PROVIDER_CATALOG } from "../providers/search-provider-catalog.js";
import { listCredentialProviderNames as listSttCredentialProviderNames } from "../providers/speech-to-text/provider-catalog.js";
import { listCatalogProviders as listTtsCatalogProviders } from "../tts/provider-catalog.js";
import {
  getPlatformAssistantId,
  getPlatformOrganizationId,
  getPlatformUserId,
  isHttpAuthDisabled,
  isPlatformIsolatedRuntime,
  POOLED_FORBIDDEN_GLOBAL_SECRET_ENV_VARS,
  resetPlatformRuntimeIdentityOverrides,
  setPlatformAssistantId,
  setPlatformOrganizationId,
  setPlatformUserId,
  validateEnv,
} from "./env.js";

function conventionalProviderEnvVar(provider: string): string {
  return `${provider.toUpperCase().replaceAll("-", "_")}_API_KEY`;
}

const MANAGED_RUNTIME_ENV_KEYS = [
  "DISABLE_HTTP_AUTH",
  "IS_PLATFORM",
  "WORKLIN_RUNTIME_MODE",
  "RUNTIME_ASSISTANT_SCOPE_MODE",
  "WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED",
  "WORKLIN_RUNTIME_WORKER_STATE_PROVIDER",
  "WORKLIN_RUNTIME_WORKER_STATE_BUCKET",
  "WORKLIN_RUNTIME_WORKER_STATE_GCS_SERVICE_ACCOUNT_JSON",
  "WORKLIN_RUNTIME_WORKER_STATE_S3_ACCESS_KEY_ID",
  "WORKLIN_RUNTIME_WORKER_STATE_S3_SECRET_ACCESS_KEY",
  "WORKLIN_RUNTIME_WORKER_STATE_S3_ENDPOINT",
  "WORKLIN_RUNTIME_WORKER_STATE_S3_REGION",
  "WORKLIN_RUNTIME_WORKER_STATE_S3_URL_STYLE",
  "ACCESS_KEY_ID",
  "SECRET_ACCESS_KEY",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_SESSION_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "WORKLIN_RUNTIME_WORKER_STACK_ID",
  "WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE",
  "WORKLIN_PLATFORM_ASSISTANT_ID",
  ...POOLED_FORBIDDEN_GLOBAL_SECRET_ENV_VARS,
] as const;

const originalEnv = new Map(
  MANAGED_RUNTIME_ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function clearManagedRuntimeEnv(): void {
  for (const key of MANAGED_RUNTIME_ENV_KEYS) delete process.env[key];
}

describe("platform runtime authentication boundary", () => {
  test("preserves the explicit auth bypass for local and self-hosted runtimes", () => {
    clearManagedRuntimeEnv();
    process.env.DISABLE_HTTP_AUTH = "true";

    expect(isPlatformIsolatedRuntime()).toBe(false);
    expect(isHttpAuthDisabled()).toBe(true);
  });

  test.each(["isolated", "pooled", "pooled_worker"])(
    "keeps authentication enabled in %s runtime mode",
    (runtimeMode) => {
      clearManagedRuntimeEnv();
      process.env.DISABLE_HTTP_AUTH = "true";
      process.env.WORKLIN_RUNTIME_MODE = runtimeMode;

      expect(isPlatformIsolatedRuntime()).toBe(true);
      expect(isHttpAuthDisabled()).toBe(false);
    },
  );

  test.each([
    ["WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED", "true"],
    ["WORKLIN_RUNTIME_WORKER_STACK_ID", "worker-stack-1"],
    ["WORKLIN_PLATFORM_ASSISTANT_ID", "assistant-1"],
  ] as const)(
    "recognizes a pooled or dedicated binding through %s",
    (key, value) => {
      clearManagedRuntimeEnv();
      process.env.DISABLE_HTTP_AUTH = "true";
      process.env[key] = value;

      expect(isPlatformIsolatedRuntime()).toBe(true);
      expect(isHttpAuthDisabled()).toBe(false);
    },
  );

  test("fails startup when a pooled worker lacks its lease authority file", () => {
    clearManagedRuntimeEnv();
    process.env.IS_PLATFORM = "true";
    process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
    process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = "worker-stack-1";

    expect(() => validateEnv()).toThrow(
      "WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE",
    );
  });

  test("fails startup when a pooled worker state transport is disabled", () => {
    clearManagedRuntimeEnv();
    process.env.IS_PLATFORM = "true";
    process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
    process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = "worker-stack-1";
    process.env.WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE =
      "/tmp/worklin-worker-authority.json";

    expect(() => validateEnv()).toThrow(
      "WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED=true",
    );
  });

  test("fails startup when a pooled worker state bucket is invalid", () => {
    clearManagedRuntimeEnv();
    process.env.IS_PLATFORM = "true";
    process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
    process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = "worker-stack-1";
    process.env.WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE =
      "/tmp/worklin-worker-authority.json";
    process.env.WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED = "true";
    process.env.WORKLIN_RUNTIME_WORKER_STATE_BUCKET = "invalid_bucket";

    expect(() => validateEnv()).toThrow(
      "WORKLIN_RUNTIME_WORKER_STATE_BUCKET is invalid",
    );
  });

  test("accepts a pooled worker with complete state handoff configuration", () => {
    clearManagedRuntimeEnv();
    process.env.IS_PLATFORM = "true";
    process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
    process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = "worker-stack-1";
    process.env.WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE =
      "/tmp/worklin-worker-authority.json";
    process.env.WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED = "true";
    process.env.WORKLIN_RUNTIME_WORKER_STATE_BUCKET = "worklin-tenant-state";

    expect(() => validateEnv()).not.toThrow();
  });

  test("accepts only non-secret Railway S3 metadata on a pooled worker", () => {
    clearManagedRuntimeEnv();
    process.env.IS_PLATFORM = "true";
    process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
    process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = "worker-stack-1";
    process.env.WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE =
      "/tmp/worklin-worker-authority.json";
    process.env.WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED = "true";
    process.env.WORKLIN_RUNTIME_WORKER_STATE_PROVIDER = "s3";
    process.env.WORKLIN_RUNTIME_WORKER_STATE_BUCKET = "worklin-tenant-state";
    process.env.WORKLIN_RUNTIME_WORKER_STATE_S3_ENDPOINT =
      "https://storage.railway.app";
    process.env.WORKLIN_RUNTIME_WORKER_STATE_S3_REGION = "auto";
    process.env.WORKLIN_RUNTIME_WORKER_STATE_S3_URL_STYLE = "virtual";

    expect(() => validateEnv()).not.toThrow();

    for (const name of [
      "WORKLIN_RUNTIME_WORKER_STATE_S3_SECRET_ACCESS_KEY",
      "ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_SESSION_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ]) {
      process.env[name] = "must-stay-control-plane";
      expect(() => validateEnv()).toThrow(
        "must not receive object-storage credentials",
      );
      delete process.env[name];
    }

    process.env.WORKLIN_RUNTIME_WORKER_STATE_S3_ENDPOINT = "https://127.0.0.1";
    expect(() => validateEnv()).toThrow("S3 state metadata is invalid");
  });

  test.each([...POOLED_FORBIDDEN_GLOBAL_SECRET_ENV_VARS])(
    "rejects global credential or tenant identity %s on a pooled worker",
    (name) => {
      clearManagedRuntimeEnv();
      process.env.IS_PLATFORM = "true";
      process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
      process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = "worker-stack-1";
      process.env.WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE =
        "/tmp/worklin-worker-authority.json";
      process.env.WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED = "true";
      process.env.WORKLIN_RUNTIME_WORKER_STATE_BUCKET = "worklin-tenant-state";
      process.env[name] = "must-stay-outside-pooled-workers";

      expect(() => validateEnv()).toThrow(
        "must not receive global integration credentials",
      );
    },
  );

  test.each([undefined, "false", "0"])(
    "rejects pooled startup unless IS_PLATFORM is true (%s)",
    (isPlatform) => {
      clearManagedRuntimeEnv();
      if (isPlatform !== undefined) process.env.IS_PLATFORM = isPlatform;
      process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";

      expect(() => validateEnv()).toThrow(
        "Pooled workers require IS_PLATFORM=true",
      );
    },
  );

  test("covers every catalogued model, search, speech, and voice provider environment key", () => {
    const forbidden = new Set<string>(POOLED_FORBIDDEN_GLOBAL_SECRET_ENV_VARS);
    const exactCatalogEnvVars = [
      ...PROVIDER_CATALOG.map((provider) => provider.envVar),
      ...SEARCH_PROVIDER_CATALOG.map((provider) => provider.envVar),
    ].filter((name): name is string => Boolean(name));
    for (const name of exactCatalogEnvVars) {
      expect(forbidden.has(name), name).toBe(true);
    }

    const providerNames = new Set([
      ...API_KEY_PROVIDERS,
      ...listSttCredentialProviderNames(),
      ...listTtsCatalogProviders().flatMap((provider) =>
        provider.secretRequirements.flatMap((requirement) => {
          const match = requirement.credentialStoreKey.match(
            /^credential\/([^/]+)\/api_key$/u,
          );
          return match?.[1] ? [match[1]] : [];
        }),
      ),
    ]);
    for (const provider of providerNames) {
      const name = conventionalProviderEnvVar(provider);
      expect(forbidden.has(name), name).toBe(true);
    }
  });

  test("clears process-local platform identity at a pooled assignment boundary", () => {
    clearManagedRuntimeEnv();
    setPlatformAssistantId("assistant-a");
    setPlatformOrganizationId("organization-a");
    setPlatformUserId("user-a");
    expect(getPlatformAssistantId()).toBe("assistant-a");
    expect(getPlatformOrganizationId()).toBe("organization-a");
    expect(getPlatformUserId()).toBe("user-a");

    resetPlatformRuntimeIdentityOverrides();

    expect(getPlatformAssistantId()).toBe("");
    expect(getPlatformOrganizationId()).toBe("");
    expect(getPlatformUserId()).toBe("");
  });
});
