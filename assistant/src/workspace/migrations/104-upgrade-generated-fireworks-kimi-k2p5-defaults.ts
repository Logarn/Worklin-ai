import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

const OLD_MODEL = "accounts/fireworks/models/kimi-k2p5";
const NEW_MODEL = "accounts/fireworks/models/kimi-k2p6";

const HEARTBEAT_KEYS = new Set([
  "provider",
  "model",
  "maxTokens",
  "effort",
  "temperature",
  "thinking",
  "contextWindow",
  "speed",
]);
const RECALL_KEYS = new Set([
  "model",
  "maxTokens",
  "effort",
  "temperature",
  "thinking",
]);
const THINKING_KEYS = new Set(["enabled", "streamThinking"]);
const CONTEXT_WINDOW_KEYS = new Set(["maxInputTokens"]);

export const upgradeGeneratedFireworksKimiK2p5DefaultsMigration: WorkspaceMigration =
  {
    id: "104-upgrade-generated-fireworks-kimi-k2p5-defaults",
    description:
      "Move generated Fireworks BYOK call-site defaults from Kimi K2.5 to Kimi K2.6",
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

      // User-owned profiles have no immutable generation marker. Their model
      // selections remain untouched even when every display field is default.
      const callSites = readObject(llm.callSites);
      if (callSites === null) return;

      let changed = false;

      const heartbeat = readObject(callSites.heartbeatAgent);
      if (heartbeat !== null && isGeneratedHeartbeatDefault(heartbeat)) {
        heartbeat.model = NEW_MODEL;
        callSites.heartbeatAgent = heartbeat;
        changed = true;
      }

      const recall = readObject(callSites.recall);
      if (recall !== null && isGeneratedRecallDefault(recall)) {
        recall.model = NEW_MODEL;
        callSites.recall = recall;
        changed = true;
      }

      if (!changed) return;

      llm.callSites = callSites;
      config.llm = llm;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    },
    down(_workspaceDir: string): void {
      // Forward-only.
    },
  };

function isGeneratedHeartbeatDefault(
  callSite: Record<string, unknown>,
): boolean {
  const thinking = readObject(callSite.thinking);
  const contextWindow = readObject(callSite.contextWindow);
  if (thinking === null || contextWindow === null) return false;

  const speed = callSite.speed;
  if (speed !== undefined && speed !== "fast" && speed !== "standard") {
    return false;
  }

  return (
    hasOnlyKeys(callSite, HEARTBEAT_KEYS) &&
    callSite.provider === "fireworks" &&
    callSite.model === OLD_MODEL &&
    callSite.maxTokens === 2048 &&
    callSite.effort === "low" &&
    callSite.temperature === 0 &&
    isDisabledThinking(thinking) &&
    hasOnlyKeys(contextWindow, CONTEXT_WINDOW_KEYS) &&
    contextWindow.maxInputTokens === 16_000
  );
}

function isGeneratedRecallDefault(callSite: Record<string, unknown>): boolean {
  const thinking = readObject(callSite.thinking);
  return (
    thinking !== null &&
    hasOnlyKeys(callSite, RECALL_KEYS) &&
    callSite.model === OLD_MODEL &&
    callSite.maxTokens === 4096 &&
    callSite.effort === "low" &&
    callSite.temperature === 0 &&
    isDisabledThinking(thinking)
  );
}

function isDisabledThinking(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, THINKING_KEYS) &&
    value.enabled === false &&
    value.streamThinking === false
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
