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

import { upgradeGeneratedFireworksKimiK2p5ProfilesMigration } from "../workspace/migrations/104-upgrade-generated-fireworks-kimi-k2p5-profiles.js";
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

function readProfiles(): Record<string, Record<string, unknown>> {
  const llm = readConfig().llm as Record<string, unknown>;
  return llm.profiles as Record<string, Record<string, unknown>>;
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

describe("104-upgrade-generated-fireworks-kimi-k2p5-profiles migration", () => {
  test("is registered after the existing migrations", () => {
    expect(WORKSPACE_MIGRATIONS.at(-1)).toBe(
      upgradeGeneratedFireworksKimiK2p5ProfilesMigration,
    );
  });

  test("upgrades onboarding and Settings generated profiles", () => {
    writeConfig({
      llm: {
        profiles: {
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
        },
      },
    });

    upgradeGeneratedFireworksKimiK2p5ProfilesMigration.run(workspaceDir);

    const profiles = readProfiles();
    expect(profiles["custom-balanced"]?.model).toBe(NEW_MODEL);
    expect(profiles["custom-balanced-2"]?.model).toBe(NEW_MODEL);
  });

  test("upgrades hatch-seeded Fireworks BYOK profiles", () => {
    writeConfig({
      llm: {
        profiles: {
          "custom-balanced": {
            source: "user",
            label: "Balanced",
            description: "Good balance of quality, cost, and speed",
            provider: "fireworks",
            provider_connection: "fireworks-personal",
            model: OLD_MODEL,
          },
          "custom-quality-optimized": {
            source: "user",
            label: "Quality",
            description: "Best results with the most capable model",
            provider: "fireworks",
            provider_connection: "fireworks-personal",
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
        },
      },
    });

    upgradeGeneratedFireworksKimiK2p5ProfilesMigration.run(workspaceDir);

    for (const profile of Object.values(readProfiles())) {
      expect(profile.model).toBe(NEW_MODEL);
    }
  });

  test("leaves intentional user-selected profiles on Kimi K2.5", () => {
    const original = {
      llm: {
        profiles: {
          "my-fireworks-profile": {
            source: "user",
            label: "My Kimi K2.5",
            description: "Keep this deployment",
            provider: "fireworks",
            provider_connection: "fireworks-personal",
            model: OLD_MODEL,
          },
          "custom-balanced": {
            source: "user",
            label: "Balanced",
            description: "User customized this profile",
            provider: "fireworks",
            provider_connection: "fireworks-personal",
            model: OLD_MODEL,
          },
        },
      },
    };
    writeConfig(original);

    upgradeGeneratedFireworksKimiK2p5ProfilesMigration.run(workspaceDir);

    expect(readConfig()).toEqual(original);
  });

  test("leaves managed, other-provider, and already-upgraded profiles unchanged", () => {
    const original = {
      llm: {
        profiles: {
          managed: {
            source: "managed",
            description: "Default provider profile",
            provider: "fireworks",
            model: OLD_MODEL,
          },
          openai: {
            source: "user",
            description: "Default provider profile",
            provider: "openai",
            model: OLD_MODEL,
          },
          upgraded: {
            source: "user",
            description: "Default provider profile",
            provider: "fireworks",
            model: NEW_MODEL,
          },
        },
      },
    };
    writeConfig(original);

    upgradeGeneratedFireworksKimiK2p5ProfilesMigration.run(workspaceDir);

    expect(readConfig()).toEqual(original);
  });

  test("gracefully handles missing or invalid config", () => {
    upgradeGeneratedFireworksKimiK2p5ProfilesMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);

    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    upgradeGeneratedFireworksKimiK2p5ProfilesMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("is idempotent", () => {
    writeConfig({
      llm: {
        profiles: {
          "custom-balanced": {
            source: "user",
            description: "Default provider selected during onboarding",
            provider: "fireworks",
            model: OLD_MODEL,
          },
        },
      },
    });

    upgradeGeneratedFireworksKimiK2p5ProfilesMigration.run(workspaceDir);
    const afterFirstRun = readFileSync(
      join(workspaceDir, "config.json"),
      "utf-8",
    );
    upgradeGeneratedFireworksKimiK2p5ProfilesMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      afterFirstRun,
    );
  });
});
