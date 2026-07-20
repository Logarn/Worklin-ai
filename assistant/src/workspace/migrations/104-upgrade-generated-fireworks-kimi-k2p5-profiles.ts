import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

const OLD_MODEL = "accounts/fireworks/models/kimi-k2p5";
const NEW_MODEL = "accounts/fireworks/models/kimi-k2p6";

const DEFAULT_PROFILE_DESCRIPTIONS = new Set([
  "Default provider selected during onboarding",
  "Default provider profile",
]);

const SEEDED_PROFILE_SHAPES: Record<
  string,
  { label: string; description: string }
> = {
  "custom-balanced": {
    label: "Balanced",
    description: "Good balance of quality, cost, and speed",
  },
  "custom-quality-optimized": {
    label: "Quality",
    description: "Best results with the most capable model",
  },
  "custom-cost-optimized": {
    label: "Speed",
    description: "Fastest responses at lower cost",
  },
};

export const upgradeGeneratedFireworksKimiK2p5ProfilesMigration: WorkspaceMigration =
  {
    id: "104-upgrade-generated-fireworks-kimi-k2p5-profiles",
    description:
      "Move generated Fireworks BYOK profiles from Kimi K2.5 to Kimi K2.6",
    run(workspaceDir: string): void {
      const configPath = join(workspaceDir, "config.json");
      if (!existsSync(configPath)) return;

      let config: Record<string, unknown>;
      try {
        const raw = JSON.parse(readFileSync(configPath, "utf-8"));
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
        config = raw as Record<string, unknown>;
      } catch {
        return;
      }

      const llm = readObject(config.llm);
      if (llm === null) return;

      const profiles = readObject(llm.profiles);
      if (profiles === null) return;

      let changed = false;
      for (const [name, value] of Object.entries(profiles)) {
        const profile = readObject(value);
        if (profile === null || !isGeneratedFireworksProfile(name, profile)) {
          continue;
        }

        profile.model = NEW_MODEL;
        profiles[name] = profile;
        changed = true;
      }

      if (!changed) return;

      llm.profiles = profiles;
      config.llm = llm;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    },
    down(_workspaceDir: string): void {
      // Forward-only.
    },
  };

function isGeneratedFireworksProfile(
  name: string,
  profile: Record<string, unknown>,
): boolean {
  if (
    profile.source !== "user" ||
    profile.provider !== "fireworks" ||
    profile.model !== OLD_MODEL
  ) {
    return false;
  }

  if (
    isGeneratedBalancedProfileName(name) &&
    typeof profile.description === "string" &&
    DEFAULT_PROFILE_DESCRIPTIONS.has(profile.description)
  ) {
    return true;
  }

  const seededShape = SEEDED_PROFILE_SHAPES[name];
  return (
    seededShape !== undefined &&
    profile.provider_connection === "fireworks-personal" &&
    profile.label === seededShape.label &&
    profile.description === seededShape.description
  );
}

function isGeneratedBalancedProfileName(name: string): boolean {
  return name === "custom-balanced" || /^custom-balanced-\d+$/.test(name);
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
