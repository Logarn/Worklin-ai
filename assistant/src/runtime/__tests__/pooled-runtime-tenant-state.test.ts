import { readFileSync } from "node:fs";
import { describe, expect, mock, test } from "bun:test";

import {
  type PooledRuntimeTenantStateResetSources,
  resetPooledRuntimeTenantProcessState,
} from "../pooled-runtime-tenant-state.js";

function createSources(
  pendingSurfacePersists: () => number = () => 0,
  pendingInteractionCount: () => number = () => 0,
): {
  sources: PooledRuntimeTenantStateResetSources;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    sources: {
      flushSurfacePersists: mock(() => calls.push("surface")),
      pendingSurfacePersists,
      pendingInteractionCount,
      resetBrowserAuthSessions: mock(() => calls.push("browser-auth")),
      resetAppStoreCaches: mock(() => calls.push("app-store")),
      resetPinnedTabs: mock(() => calls.push("pinned-tabs")),
      resetCredentialBroker: mock(() => calls.push("credentials")),
      resetToolRegistry: mock(() => calls.push("tool-registry")),
      resetGatewayThresholdCache: mock(() => calls.push("thresholds")),
      resetAssistantStreamState: mock(() => calls.push("stream")),
      resetConversationSuggestions: mock(() => calls.push("suggestions")),
      resetConfigCache: mock(() => calls.push("config")),
      resetPlatformIdentity: mock(() => calls.push("platform-identity")),
      resetDefaultPluginState: mock(() => calls.push("default-plugins")),
      resetArbitrarySkillCache: mock(() => calls.push("skill-cache")),
      resetAudioStore: mock(() => calls.push("audio")),
      resetPermissionRiskCache: mock(() => calls.push("risk")),
      resetProviderCaches: mock(() => calls.push("providers")),
      resetEmbeddingCaches: mock(() => calls.push("embeddings")),
      resetMemoryIndexes: mock(() => calls.push("memory-indexes")),
      resetMemoryCapabilityStores: mock(() =>
        calls.push("memory-capabilities"),
      ),
      resetAppGitState: mock(() => calls.push("app-git")),
      resetWorkspaceGitRegistry: mock(() => calls.push("workspace-git")),
      resetWorkspaceQuota: mock(() => calls.push("workspace-quota")),
    },
  };
}

describe("pooled runtime tenant process state", () => {
  test("clears every assignment-bound process store after flushing timers", () => {
    const { sources, calls } = createSources();

    resetPooledRuntimeTenantProcessState(sources);

    expect(calls).toEqual([
      "surface",
      "browser-auth",
      "app-store",
      "pinned-tabs",
      "credentials",
      "tool-registry",
      "thresholds",
      "stream",
      "suggestions",
      "config",
      "platform-identity",
      "default-plugins",
      "skill-cache",
      "audio",
      "risk",
      "providers",
      "embeddings",
      "memory-indexes",
      "memory-capabilities",
      "app-git",
      "workspace-git",
      "workspace-quota",
    ]);
  });

  test("refuses worker reuse while a delayed surface write remains", () => {
    const { sources, calls } = createSources(() => 1);

    expect(() => resetPooledRuntimeTenantProcessState(sources)).toThrow(
      "could not clear pending surface persistence timers",
    );
    expect(calls).toEqual(["surface"]);
  });

  test("refuses worker reuse while an interaction lifecycle remains", () => {
    const { sources, calls } = createSources(
      () => 0,
      () => 1,
    );

    expect(() => resetPooledRuntimeTenantProcessState(sources)).toThrow(
      "still has pending interaction lifecycles",
    );
    expect(calls).toEqual(["surface"]);
  });

  test("provider startup clears pooled identity before any secure-store rehydration", () => {
    const source = readFileSync(
      new URL("../../daemon/providers-setup.ts", import.meta.url),
      "utf8",
    );
    const pooledBranch = source.indexOf("if (pooledRuntime)");
    const firstCredentialRead = source.indexOf(
      'credentialKey("vellum", "platform_base_url")',
    );
    expect(pooledBranch).toBeGreaterThan(-1);
    expect(pooledBranch).toBeLessThan(firstCredentialRead);
    expect(source.slice(pooledBranch, firstCredentialRead)).toContain(
      "resetPlatformRuntimeIdentityOverrides",
    );
    expect(source.slice(pooledBranch, firstCredentialRead)).toContain(
      "setSentryOrganizationId(undefined)",
    );
    expect(source.slice(pooledBranch, firstCredentialRead)).toContain(
      "} else {",
    );
  });
});
