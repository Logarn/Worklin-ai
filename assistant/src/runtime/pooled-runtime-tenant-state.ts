import { resetAudioStoreForTenantAssignment } from "../calls/audio-store.js";
import { resetPlatformRuntimeIdentityOverrides } from "../config/env.js";
import { installPooledRuntimeNeutralConfig } from "../config/loader.js";
import {
  flushPendingSurfaceDataPersists,
  pendingSurfaceDataPersistCount,
} from "../daemon/conversation-surfaces.js";
import { setSentryOrganizationId, setSentryUserId } from "../instrument.js";
import { resetAnisotropyCacheForTenantAssignment } from "../memory/anisotropy.js";
import { resetAppGitStateForTenantAssignment } from "../memory/app-git-service.js";
import { resetAppStoreCachesForTenantAssignment } from "../memory/app-store.js";
import { clearEmbeddingBackendCache } from "../memory/embedding-backend.js";
import { resetRerankBackendForTenantAssignment } from "../memory/rerank-local.js";
import { resetCliCommandStoreForTenantAssignment } from "../memory/v2/cli-command-store.js";
import { invalidateEdgeIndex } from "../memory/v2/edge-index.js";
import { invalidatePageIndex } from "../memory/v2/page-index.js";
import { resetRerankCacheForTenantAssignment } from "../memory/v2/reranker.js";
import { resetSkillStoreForTenantAssignment } from "../memory/v2/skill-store.js";
import { resetCorpusStatsForTenantAssignment } from "../memory/v2/sparse-bm25.js";
import { clearRiskCache } from "../permissions/checker.js";
import { resetGatewayThresholdCacheForTenantAssignment } from "../permissions/gateway-threshold-reader.js";
import { resetDefaultPluginStateForTenantAssignment } from "../plugins/defaults/index.js";
import { clearConnectionProviderCache } from "../providers/registry.js";
import { resetSkillCacheForTenantAssignment } from "../skills/skill-cache-store.js";
import { authSessionCache } from "../tools/browser/auth-cache.js";
import { clearAllPinnedTabs } from "../tools/browser/pinned-tabs.js";
import { resetCredentialBrokerForTenantAssignment } from "../tools/credentials/broker.js";
import { resetToolRegistryForTenantAssignment } from "../tools/registry.js";
import { resetGitServiceRegistryForTenantAssignment } from "../workspace/git-service.js";
import { resetAssistantStreamStateForTenantAssignment } from "./assistant-stream-state.js";
import { resetConversationSuggestionStateForTenantAssignment } from "./conversation-suggestion-cache.js";
import * as pendingInteractions from "./pending-interactions.js";
import { resetPooledWorkspaceQuotaForTenantAssignment } from "./pooled-workspace-quota.js";
import { ServiceUnavailableError } from "./routes/errors.js";

export interface PooledRuntimeTenantStateResetSources {
  flushSurfacePersists(): void;
  pendingSurfacePersists(): number;
  pendingInteractionCount(): number;
  resetBrowserAuthSessions(): void;
  resetAppStoreCaches(): void;
  resetPinnedTabs(): void;
  resetCredentialBroker(): void;
  resetToolRegistry(): void;
  resetGatewayThresholdCache(): void;
  resetAssistantStreamState(): void;
  resetConversationSuggestions(): void;
  resetConfigCache(): void;
  resetPlatformIdentity(): void;
  resetDefaultPluginState(): void;
  resetArbitrarySkillCache(): void;
  resetAudioStore(): void;
  resetPermissionRiskCache(): void;
  resetProviderCaches(): void;
  resetEmbeddingCaches(): void;
  resetMemoryIndexes(): void;
  resetMemoryCapabilityStores(): void;
  resetAppGitState(): void;
  resetWorkspaceGitRegistry(): void;
  resetWorkspaceQuota(): void;
}

/**
 * Clear every known process-local value that is scoped to one pooled worker
 * assignment. Callers hold the drain fence while this runs, after quiescence
 * has been proven, so no tenant work can repopulate these stores concurrently.
 */
export function resetPooledRuntimeTenantProcessState(
  sources: PooledRuntimeTenantStateResetSources = productionResetSources(),
): void {
  // A delayed write is the only source here that can execute later. Flush it
  // first and refuse reuse unless the timer registry is demonstrably empty.
  sources.flushSurfacePersists();
  if (sources.pendingSurfacePersists() !== 0) {
    throw new ServiceUnavailableError(
      "Pooled runtime could not clear pending surface persistence timers.",
    );
  }
  // Pending interactions own timers, abort listeners, and Promise resolvers.
  // `pendingInteractions.clear()` would orphan all three, so the drain proof
  // must make this store empty naturally. Quarantine rather than reassign a
  // worker if any request lifecycle is still live.
  if (sources.pendingInteractionCount() !== 0) {
    throw new ServiceUnavailableError(
      "Pooled runtime still has pending interaction lifecycles after drain.",
    );
  }

  sources.resetBrowserAuthSessions();
  sources.resetAppStoreCaches();
  sources.resetPinnedTabs();
  sources.resetCredentialBroker();
  sources.resetToolRegistry();
  sources.resetGatewayThresholdCache();
  sources.resetAssistantStreamState();
  sources.resetConversationSuggestions();
  sources.resetConfigCache();
  sources.resetPlatformIdentity();
  sources.resetDefaultPluginState();
  sources.resetArbitrarySkillCache();
  sources.resetAudioStore();
  sources.resetPermissionRiskCache();
  sources.resetProviderCaches();
  sources.resetEmbeddingCaches();
  sources.resetMemoryIndexes();
  sources.resetMemoryCapabilityStores();
  sources.resetAppGitState();
  sources.resetWorkspaceGitRegistry();
  sources.resetWorkspaceQuota();
}

function productionResetSources(): PooledRuntimeTenantStateResetSources {
  return {
    flushSurfacePersists: () => flushPendingSurfaceDataPersists(),
    pendingSurfacePersists: pendingSurfaceDataPersistCount,
    pendingInteractionCount: () => pendingInteractions.getAll().length,
    resetBrowserAuthSessions: () => authSessionCache.resetForTenantAssignment(),
    resetAppStoreCaches: resetAppStoreCachesForTenantAssignment,
    resetPinnedTabs: clearAllPinnedTabs,
    resetCredentialBroker: resetCredentialBrokerForTenantAssignment,
    resetToolRegistry: resetToolRegistryForTenantAssignment,
    resetGatewayThresholdCache: resetGatewayThresholdCacheForTenantAssignment,
    resetAssistantStreamState: resetAssistantStreamStateForTenantAssignment,
    resetConversationSuggestions:
      resetConversationSuggestionStateForTenantAssignment,
    resetConfigCache: () => {
      installPooledRuntimeNeutralConfig();
    },
    resetPlatformIdentity: () => {
      resetPlatformRuntimeIdentityOverrides();
      setSentryOrganizationId(undefined);
      setSentryUserId(undefined);
    },
    resetDefaultPluginState: resetDefaultPluginStateForTenantAssignment,
    resetArbitrarySkillCache: resetSkillCacheForTenantAssignment,
    resetAudioStore: resetAudioStoreForTenantAssignment,
    resetPermissionRiskCache: clearRiskCache,
    resetProviderCaches: clearConnectionProviderCache,
    resetEmbeddingCaches: () => {
      clearEmbeddingBackendCache();
      resetRerankBackendForTenantAssignment();
      resetRerankCacheForTenantAssignment();
      resetAnisotropyCacheForTenantAssignment();
      resetCorpusStatsForTenantAssignment();
    },
    resetMemoryIndexes: () => {
      invalidatePageIndex();
      invalidateEdgeIndex();
    },
    resetMemoryCapabilityStores: () => {
      resetSkillStoreForTenantAssignment();
      resetCliCommandStoreForTenantAssignment();
    },
    resetAppGitState: resetAppGitStateForTenantAssignment,
    resetWorkspaceGitRegistry: resetGitServiceRegistryForTenantAssignment,
    resetWorkspaceQuota: resetPooledWorkspaceQuotaForTenantAssignment,
  };
}
