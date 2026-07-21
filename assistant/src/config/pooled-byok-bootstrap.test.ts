import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { getDb, resetDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import {
  getConnection,
  upsertConnection,
} from "../providers/inference/connections.js";
import { resolveModelIntent } from "../providers/model-intents.js";
import { resolveCallSiteConfig } from "./llm-resolver.js";
import { loadConfig, loadRawConfig, saveRawConfig } from "./loader.js";
import {
  assertPooledByokInferenceReady,
  bootstrapPooledByokInference,
} from "./pooled-byok-bootstrap.js";

const roots: string[] = [];
const previousWorkspace = process.env.VELLUM_WORKSPACE_DIR;
const previousPlatform = process.env.IS_PLATFORM;

afterEach(() => {
  resetDb();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  if (previousWorkspace === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspace;
  }
  if (previousPlatform === undefined) {
    delete process.env.IS_PLATFORM;
  } else {
    process.env.IS_PLATFORM = previousPlatform;
  }
});

function initializeWorkspace(): void {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "pooled-byok-")));
  roots.push(workspace);
  process.env.VELLUM_WORKSPACE_DIR = workspace;
  process.env.IS_PLATFORM = "true";
  resetDb();
  initializeDb({ useTestTemplate: false });
}

test("missing tenant choice stays setup-required and cannot auto-select a restored managed connection", () => {
  initializeWorkspace();
  expect(
    upsertConnection(getDb(), {
      name: "anthropic-managed",
      provider: "anthropic",
      auth: { type: "platform" },
      label: "Worklin Managed",
    }).ok,
  ).toBe(true);
  saveRawConfig({
    llm: {
      default: {
        provider: "anthropic",
        model: resolveModelIntent("anthropic", "balanced"),
        provider_connection: "anthropic-managed",
      },
      profiles: {
        balanced: {
          source: "managed",
          status: "active",
          provider: "anthropic",
          model: resolveModelIntent("anthropic", "balanced"),
          provider_connection: "anthropic-managed",
        },
      },
      activeProfile: "balanced",
    },
  });

  expect(bootstrapPooledByokInference(getDb())).toEqual({
    status: "setup_required",
  });
  // Re-running bootstrap must not reinterpret the schema's Anthropic default
  // as a personal-provider choice.
  expect(bootstrapPooledByokInference(getDb())).toEqual({
    status: "setup_required",
  });

  const raw = loadRawConfig();
  const llm = raw.llm as Record<string, unknown>;
  const profiles = llm.profiles as Record<string, Record<string, unknown>>;
  expect(llm.activeProfile).toBeUndefined();
  expect(profiles.balanced?.status).toBe("disabled");
  expect(profiles["byok-setup-required"]).toMatchObject({
    source: "user",
    status: "disabled",
  });
  expect(llm.default).toMatchObject({
    provider_connection: "byok-setup-required",
  });

  const resolved = resolveCallSiteConfig("mainAgent", loadConfig().llm);
  expect(resolved.provider_connection).toBe("byok-setup-required");
  expect(
    resolveCallSiteConfig("mainAgent", loadConfig().llm, {
      overrideProfile: "balanced",
    }).provider_connection,
  ).toBe("byok-setup-required");
  expect(getConnection(getDb(), "byok-setup-required")).toBeNull();
  expect(() => assertPooledByokInferenceReady(getDb())).toThrow(
    "BYOK connection is incomplete",
  );
});

test("a tenant provider hint replaces setup-required with a personal credential reference only", () => {
  initializeWorkspace();
  expect(bootstrapPooledByokInference(getDb())).toEqual({
    status: "setup_required",
  });
  const setupRaw = loadRawConfig();
  const setupLlm = setupRaw.llm as {
    profiles: Record<string, unknown>;
  };
  setupLlm.profiles["legacy-managed"] = {
    source: "managed",
    status: "disabled",
    provider: "anthropic",
    model: resolveModelIntent("anthropic", "balanced"),
    provider_connection: "anthropic-managed",
  };
  saveRawConfig(setupRaw);

  expect(bootstrapPooledByokInference(getDb(), "kimi")).toEqual({
    status: "ready",
    provider: "kimi",
    connectionName: "kimi-personal",
    activeProfile: "custom-balanced",
  });
  expect(getConnection(getDb(), "kimi-personal")).toMatchObject({
    provider: "kimi",
    auth: {
      type: "api_key",
      credential: "credential/kimi/api_key",
    },
  });
  const raw = loadRawConfig();
  const config = loadConfig();
  expect(
    resolveCallSiteConfig("mainAgent", config.llm, {
      overrideProfile: "legacy-managed",
    }),
  ).toMatchObject({
    provider: "kimi",
    provider_connection: "kimi-personal",
  });
  expect(
    Object.values(config.llm.profiles).every(
      (profile) =>
        profile.provider_connection === undefined ||
        profile.provider_connection === "kimi-personal",
    ),
  ).toBe(true);
  expect(
    (raw.llm as { profiles?: Record<string, unknown> }).profiles,
  ).not.toHaveProperty("byok-setup-required");
  expect(() => assertPooledByokInferenceReady(getDb())).not.toThrow();
});
