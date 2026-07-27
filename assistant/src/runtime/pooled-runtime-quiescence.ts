import { getAcpSessionManager } from "../acp/index.js";
import {
  activeCallControllerCount,
  destroyAllCallControllers,
} from "../calls/call-state.js";
import { activeMediaStreamSessions } from "../calls/media-stream-server.js";
import { activeRelayConnections } from "../calls/relay-server.js";
import { activeConversationAgentLoopCount } from "../daemon/conversation-agent-loop-registry.js";
import { conversationCount } from "../daemon/conversation-registry.js";
import { clearAllActiveConversations } from "../daemon/conversation-store.js";
import { getSubagentManager } from "../subagent/index.js";
import {
  activeBackgroundToolExecutionCount,
  cancelBackgroundTools,
} from "../tools/background-tool-registry.js";
import { browserManager } from "../tools/browser/browser-manager.js";
import {
  credentialBroker,
  resetCredentialBrokerForTenantAssignment,
} from "../tools/credentials/broker.js";
import { getWorkflowRunManager } from "../workflows/run-manager.js";
import {
  activeAssistantEventHubWorkCount,
  assistantEventHub,
} from "./assistant-event-hub.js";
import { migrationJobs } from "./migrations/job-registry.js";
import {
  installPooledRuntimeQuiescenceProbe,
  type PooledRuntimeLeaseIdentity,
  type PooledRuntimeQuiescenceProbe,
  type PooledRuntimeQuiescenceProof,
} from "./pooled-runtime-drain-fence.js";
import { ServiceUnavailableError } from "./routes/errors.js";

const DEFAULT_QUIESCE_TIMEOUT_MS = 2_000;

export interface PooledRuntimeQuiescenceSources {
  cancelBackgroundTools(): void;
  activeBackgroundTools(): number;
  activeMigrationJobs(): number;
  quiesceWorkflows(timeoutMs: number): Promise<boolean>;
  activeWorkflows(): number;
  quiesceSubagents(timeoutMs: number): Promise<boolean>;
  activeSubagents(): number;
  closeAcpSessions(): void;
  activeAcpSessions(): number;
  closeBrowserResources(): Promise<void>;
  activeBrowserResources(): number;
  closeCallResources(): void;
  activeCallResources(): number;
  clearConversations(): void;
  activeConversations(): number;
  activeConversationAgentLoops(): number;
  closeAssistantEventSubscribers(): void;
  activeAssistantEventSubscribers(): number;
  activeAssistantEventHubWork(): number;
  clearCredentialBrokerState(): void;
  activeCredentialBrokerTokens(): number;
  activeTransientCredentialValues(): number;
}

export class PooledRuntimeProductionQuiescenceProbe implements PooledRuntimeQuiescenceProbe {
  private acpReuseUnsafe = false;

  constructor(
    private readonly sources: PooledRuntimeQuiescenceSources,
    private readonly timeoutMs = DEFAULT_QUIESCE_TIMEOUT_MS,
  ) {}

  async proveQuiescent(
    _identity: PooledRuntimeLeaseIdentity,
  ): Promise<PooledRuntimeQuiescenceProof> {
    this.sources.cancelBackgroundTools();
    const workflowSettled = await this.sources.quiesceWorkflows(this.timeoutMs);
    const subagentsSettled = await this.sources.quiesceSubagents(
      this.timeoutMs,
    );

    if (this.sources.activeAcpSessions() > 0) {
      // ACP exposes process termination but not an awaitable promise for every
      // in-flight prompt callback. Once observed, this worker cannot prove
      // process-level reuse safety and remains quarantined until restart.
      this.acpReuseUnsafe = true;
      this.sources.closeAcpSessions();
    }

    await this.sources.closeBrowserResources();
    this.sources.closeCallResources();
    this.sources.clearConversations();
    this.sources.closeAssistantEventSubscribers();

    const agentLoopsSettled = await waitForZero(
      () => this.sources.activeConversationAgentLoops(),
      this.timeoutMs,
    );
    const eventHubSettled = await waitForZero(
      () => this.sources.activeAssistantEventHubWork(),
      this.timeoutMs,
    );
    const backgroundSettled = await waitForZero(
      () => this.sources.activeBackgroundTools(),
      this.timeoutMs,
    );
    const migrationsSettled = await waitForZero(
      () => this.sources.activeMigrationJobs(),
      this.timeoutMs,
    );
    const failures: string[] = [];
    if (!backgroundSettled) failures.push("background tools");
    if (!migrationsSettled) failures.push("migration jobs");
    if (!workflowSettled || this.sources.activeWorkflows() !== 0) {
      failures.push("workflow runs");
    }
    if (!subagentsSettled || this.sources.activeSubagents() !== 0) {
      failures.push("subagent runs");
    }
    if (this.acpReuseUnsafe || this.sources.activeAcpSessions() !== 0) {
      failures.push("ACP sessions");
    }
    if (this.sources.activeBrowserResources() !== 0) {
      failures.push("browser resources");
    }
    if (this.sources.activeCallResources() !== 0) {
      failures.push("telephony calls");
    }
    if (this.sources.activeConversations() !== 0) {
      failures.push("conversation runtimes");
    }
    if (this.sources.activeAssistantEventSubscribers() !== 0) {
      failures.push("assistant event subscribers");
    }
    if (!agentLoopsSettled) {
      failures.push("conversation agent loops");
    }
    if (!eventHubSettled) {
      failures.push("assistant event hub work");
    }

    if (failures.length === 0) {
      // Only clear assignment-bound capability state after every tenant
      // execution source has reached zero. The drain fence prevents new work
      // from racing this final handoff step.
      this.sources.clearCredentialBrokerState();
      if (this.sources.activeCredentialBrokerTokens() !== 0) {
        failures.push("credential usage tokens");
      }
      if (this.sources.activeTransientCredentialValues() !== 0) {
        failures.push("transient credential values");
      }
    }

    if (failures.length > 0) {
      throw new ServiceUnavailableError(
        `Pooled runtime could not prove quiescence for: ${failures.join(", ")}.`,
      );
    }

    return {
      activeTenantProcessCount: 0,
      activeTenantSessionCount: 0,
    };
  }
}

export function createProductionPooledRuntimeQuiescenceSources(): PooledRuntimeQuiescenceSources {
  return {
    cancelBackgroundTools: () => {
      cancelBackgroundTools(
        () => true,
        "Pooled runtime assignment is draining.",
      );
    },
    activeBackgroundTools: activeBackgroundToolExecutionCount,
    activeMigrationJobs: () => migrationJobs.inFlightCount(),
    quiesceWorkflows: (timeoutMs) => getWorkflowRunManager().quiesce(timeoutMs),
    activeWorkflows: () => getWorkflowRunManager().inflightCount(),
    quiesceSubagents: (timeoutMs) => getSubagentManager().quiesce(timeoutMs),
    activeSubagents: () => getSubagentManager().activeCount,
    closeAcpSessions: () => getAcpSessionManager().closeAll(),
    activeAcpSessions: () =>
      getAcpSessionManager().getActiveAndPendingIds().length,
    closeBrowserResources: () => browserManager.closeAllPages(),
    activeBrowserResources: () => browserManager.activeResourceCount,
    closeCallResources: closeProductionCallResources,
    activeCallResources: activeProductionCallResourceCount,
    clearConversations: () => {
      clearAllActiveConversations();
    },
    activeConversations: conversationCount,
    activeConversationAgentLoops: activeConversationAgentLoopCount,
    closeAssistantEventSubscribers: () => {
      assistantEventHub.disposeAllSubscribers();
    },
    activeAssistantEventSubscribers: () => assistantEventHub.subscriberCount(),
    activeAssistantEventHubWork: activeAssistantEventHubWorkCount,
    clearCredentialBrokerState: resetCredentialBrokerForTenantAssignment,
    activeCredentialBrokerTokens: () => credentialBroker.activeTokenCount,
    activeTransientCredentialValues: () => credentialBroker.transientValueCount,
  };
}

export function installProductionPooledRuntimeQuiescenceProbe(): () => void {
  return installPooledRuntimeQuiescenceProbe(
    new PooledRuntimeProductionQuiescenceProbe(
      createProductionPooledRuntimeQuiescenceSources(),
    ),
  );
}

function closeProductionCallResources(): void {
  for (const [id, relay] of [...activeRelayConnections]) {
    relay.endSession("Pooled runtime assignment is draining.");
    relay.destroy();
    activeRelayConnections.delete(id);
  }
  for (const [id, session] of [...activeMediaStreamSessions]) {
    session.getOutput().endSession("Pooled runtime assignment is draining.");
    session.destroy();
    activeMediaStreamSessions.delete(id);
  }
  destroyAllCallControllers();
}

function activeProductionCallResourceCount(): number {
  return (
    activeRelayConnections.size +
    activeMediaStreamSessions.size +
    activeCallControllerCount()
  );
}

async function waitForZero(
  count: () => number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (count() !== 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return count() === 0;
}
