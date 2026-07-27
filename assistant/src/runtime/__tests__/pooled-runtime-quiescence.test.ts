import { describe, expect, test } from "bun:test";

import type { PooledRuntimeLeaseIdentity } from "../pooled-runtime-drain-fence.js";
import {
  PooledRuntimeProductionQuiescenceProbe,
  type PooledRuntimeQuiescenceSources,
} from "../pooled-runtime-quiescence.js";

const IDENTITY: PooledRuntimeLeaseIdentity = {
  tenant: { orgId: "org-1", assistantId: "assistant-1" },
  workerStackId: "worker-1",
  generation: 3,
};

function sourceHarness(
  overrides: Partial<PooledRuntimeQuiescenceSources> = {},
): PooledRuntimeQuiescenceSources & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    cancelBackgroundTools: () => calls.push("background"),
    activeBackgroundTools: () => 0,
    activeMigrationJobs: () => 0,
    quiesceWorkflows: async () => {
      calls.push("workflows");
      return true;
    },
    activeWorkflows: () => 0,
    quiesceSubagents: async () => {
      calls.push("subagents");
      return true;
    },
    activeSubagents: () => 0,
    closeAcpSessions: () => calls.push("acp"),
    activeAcpSessions: () => 0,
    closeBrowserResources: async () => {
      calls.push("browser");
    },
    activeBrowserResources: () => 0,
    closeCallResources: () => calls.push("calls"),
    activeCallResources: () => 0,
    clearConversations: () => calls.push("conversations"),
    activeConversations: () => 0,
    activeConversationAgentLoops: () => 0,
    closeAssistantEventSubscribers: () => calls.push("event subscribers"),
    activeAssistantEventSubscribers: () => 0,
    activeAssistantEventHubWork: () => 0,
    clearCredentialBrokerState: () => calls.push("credentials"),
    activeCredentialBrokerTokens: () => 0,
    activeTransientCredentialValues: () => 0,
    ...overrides,
  };
}

describe("pooled runtime production quiescence", () => {
  test("returns zero proof only after every enumerated source is closed", async () => {
    const sources = sourceHarness();
    const probe = new PooledRuntimeProductionQuiescenceProbe(sources, 20);

    await expect(probe.proveQuiescent(IDENTITY)).resolves.toEqual({
      activeTenantProcessCount: 0,
      activeTenantSessionCount: 0,
    });
    expect(sources.calls).toEqual([
      "background",
      "workflows",
      "subagents",
      "browser",
      "calls",
      "conversations",
      "event subscribers",
      "credentials",
    ]);
  });

  test("fails closed when an execution registry does not reach zero", async () => {
    const sources = sourceHarness({
      activeBackgroundTools: () => 1,
    });
    const probe = new PooledRuntimeProductionQuiescenceProbe(sources, 1);

    await expect(probe.proveQuiescent(IDENTITY)).rejects.toThrow(
      "background tools",
    );
  });

  test("fails closed while an aborted conversation agent loop is still settling", async () => {
    const sources = sourceHarness({
      activeConversationAgentLoops: () => 1,
    });
    const probe = new PooledRuntimeProductionQuiescenceProbe(sources, 1);

    await expect(probe.proveQuiescent(IDENTITY)).rejects.toThrow(
      "conversation agent loops",
    );
  });

  test("fails closed while assistant event side effects are still settling", async () => {
    const sources = sourceHarness({
      activeAssistantEventHubWork: () => 1,
    });
    const probe = new PooledRuntimeProductionQuiescenceProbe(sources, 1);

    await expect(probe.proveQuiescent(IDENTITY)).rejects.toThrow(
      "assistant event hub work",
    );
  });

  test("fails closed when an assistant event subscriber survives disposal", async () => {
    const sources = sourceHarness({
      activeAssistantEventSubscribers: () => 1,
    });
    const probe = new PooledRuntimeProductionQuiescenceProbe(sources, 1);

    await expect(probe.proveQuiescent(IDENTITY)).rejects.toThrow(
      "assistant event subscribers",
    );
  });

  test("fails closed when assignment-bound transient credentials survive cleanup", async () => {
    const sources = sourceHarness({
      clearCredentialBrokerState: () => {},
      activeTransientCredentialValues: () => 1,
    });
    const probe = new PooledRuntimeProductionQuiescenceProbe(sources, 20);

    await expect(probe.proveQuiescent(IDENTITY)).rejects.toThrow(
      "transient credential values",
    );
  });

  test("clears credential state only after all execution sources reach zero", async () => {
    let activeTokens = 1;
    let transientValues = 1;
    const sources = sourceHarness({
      clearCredentialBrokerState: () => {
        sources.calls.push("credentials");
        activeTokens = 0;
        transientValues = 0;
      },
      activeCredentialBrokerTokens: () => activeTokens,
      activeTransientCredentialValues: () => transientValues,
    });
    const probe = new PooledRuntimeProductionQuiescenceProbe(sources, 20);

    await expect(probe.proveQuiescent(IDENTITY)).resolves.toEqual({
      activeTenantProcessCount: 0,
      activeTenantSessionCount: 0,
    });
    expect(sources.calls.at(-1)).toBe("credentials");
    expect(activeTokens).toBe(0);
    expect(transientValues).toBe(0);
  });

  test("never reuses a worker after observing ACP activity without awaitable completion proof", async () => {
    let activeAcp = 1;
    const sources = sourceHarness({
      activeAcpSessions: () => activeAcp,
      closeAcpSessions: () => {
        activeAcp = 0;
      },
    });
    const probe = new PooledRuntimeProductionQuiescenceProbe(sources, 20);

    await expect(probe.proveQuiescent(IDENTITY)).rejects.toThrow(
      "ACP sessions",
    );
    await expect(probe.proveQuiescent(IDENTITY)).rejects.toThrow(
      "ACP sessions",
    );
  });
});
