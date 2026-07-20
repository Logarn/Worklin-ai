import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { upgradeGeneratedFireworksKimiK2p5DefaultsMigration } from "../workspace/migrations/104-upgrade-generated-fireworks-kimi-k2p5-defaults.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";

const OLD_MODEL = "accounts/fireworks/models/kimi-k2p5";
const NEW_MODEL = "accounts/fireworks/models/kimi-k2p6";

let workspaceDir: string;

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

function generatedHeartbeat(extra: Record<string, unknown> = {}) {
  return {
    provider: "fireworks",
    model: OLD_MODEL,
    maxTokens: 2048,
    effort: "low",
    temperature: 0,
    thinking: { enabled: false, streamThinking: false },
    contextWindow: { maxInputTokens: 16_000 },
    ...extra,
  };
}

function generatedRecall(extra: Record<string, unknown> = {}) {
  return {
    model: OLD_MODEL,
    maxTokens: 4096,
    effort: "low",
    thinking: { enabled: false, streamThinking: false },
    temperature: 0,
    ...extra,
  };
}

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-104-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("104-upgrade-generated-fireworks-kimi-k2p5-defaults migration", () => {
  test("is registered after the existing migrations", () => {
    expect(WORKSPACE_MIGRATIONS.at(-1)).toBe(
      upgradeGeneratedFireworksKimiK2p5DefaultsMigration,
    );
  });

  test("upgrades generated heartbeat and recall call-site defaults", () => {
    writeConfig({
      llm: {
        callSites: {
          heartbeatAgent: generatedHeartbeat(),
          recall: generatedRecall(),
        },
      },
    });

    upgradeGeneratedFireworksKimiK2p5DefaultsMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.heartbeatAgent?.model).toBe(NEW_MODEL);
    expect(config.llm.callSites.recall?.model).toBe(NEW_MODEL);
  });

  test("upgrades heartbeat defaults carrying migration 038's speed leaf", () => {
    writeConfig({
      llm: {
        callSites: {
          heartbeatAgent: generatedHeartbeat({ speed: "fast" }),
        },
      },
    });

    upgradeGeneratedFireworksKimiK2p5DefaultsMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.heartbeatAgent).toEqual({
      ...generatedHeartbeat({ speed: "fast" }),
      model: NEW_MODEL,
    });
  });

  test("preserves ambiguous or user-customized call-site values", () => {
    const original = {
      llm: {
        callSites: {
          heartbeatAgent: generatedHeartbeat({ maxTokens: 8192 }),
          recall: { model: OLD_MODEL },
        },
      },
    };
    writeConfig(original);

    upgradeGeneratedFireworksKimiK2p5DefaultsMigration.run(workspaceDir);

    expect(readConfig()).toEqual(original);
  });

  test("preserves default-looking intentional user profiles", () => {
    const profiles = {
      "custom-balanced": {
        source: "user",
        label: "Balanced",
        description: "Default provider selected during onboarding",
        provider: "fireworks",
        provider_connection: "fireworks-personal",
        model: OLD_MODEL,
      },
      "custom-balanced-2": {
        source: "user",
        label: "Balanced",
        description: "Default provider profile",
        provider: "fireworks",
        provider_connection: "fireworks",
        model: OLD_MODEL,
      },
      "custom-cost-optimized": {
        source: "user",
        label: "Speed",
        description: "Fastest responses at lower cost",
        provider: "fireworks",
        provider_connection: "fireworks-personal",
        model: OLD_MODEL,
      },
    };
    writeConfig({
      llm: {
        profiles,
        callSites: { heartbeatAgent: generatedHeartbeat() },
      },
    });

    upgradeGeneratedFireworksKimiK2p5DefaultsMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: {
        profiles: typeof profiles;
        callSites: Record<string, Record<string, unknown>>;
      };
    };
    expect(config.llm.profiles).toEqual(profiles);
    expect(config.llm.callSites.heartbeatAgent?.model).toBe(NEW_MODEL);
  });

  test("gracefully handles missing or invalid config", () => {
    upgradeGeneratedFireworksKimiK2p5DefaultsMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);

    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    upgradeGeneratedFireworksKimiK2p5DefaultsMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("is idempotent", () => {
    writeConfig({
      llm: {
        callSites: {
          heartbeatAgent: generatedHeartbeat(),
          recall: generatedRecall(),
        },
      },
    });

    upgradeGeneratedFireworksKimiK2p5DefaultsMigration.run(workspaceDir);
    const afterFirstRun = readFileSync(
      join(workspaceDir, "config.json"),
      "utf-8",
    );
    upgradeGeneratedFireworksKimiK2p5DefaultsMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      afterFirstRun,
    );
  });
});
