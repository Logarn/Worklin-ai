import { describe, expect, test } from "bun:test";

import type { AuthContext, Scope } from "../auth/types.js";
import {
  PooledRuntimeDrainFence,
  type PooledRuntimeLeaseIdentity,
} from "../pooled-runtime-drain-fence.js";

const IDENTITY: PooledRuntimeLeaseIdentity = {
  tenant: { orgId: "org-1", assistantId: "assistant-1" },
  workerStackId: "worker-1",
  generation: 4,
};

function auth(identity: PooledRuntimeLeaseIdentity = IDENTITY): AuthContext {
  return {
    subject: "actor:self:user-1",
    principalType: "actor",
    assistantId: "self",
    scopeProfile: "actor_client_v1",
    scopes: new Set<Scope>(["chat.write"]),
    policyEpoch: 1,
    pooledWorkerLease: {
      version: 1,
      organizationId: identity.tenant.orgId,
      userId: "user-1",
      assistantId: identity.tenant.assistantId,
      workerStackId: identity.workerStackId,
      leaseGeneration: identity.generation,
      leaseExpiresAtSeconds: 4_000_000_000,
    },
  };
}

function fence() {
  return new PooledRuntimeDrainFence(() => true, {
    proveQuiescent: async () => ({
      activeTenantProcessCount: 0,
      activeTenantSessionCount: 0,
    }),
  });
}

async function activate(value: PooledRuntimeDrainFence, identity = IDENTITY) {
  value.beginAssignmentMutation(identity);
  await value.proveAssignmentMutationQuiescent(identity);
  value.activateAssignment(identity);
}

describe("pooled runtime drain fence", () => {
  test("starts quarantined and requires a proven assignment mutation before ordinary work", async () => {
    const value = fence();
    expect(() => value.acquireOrdinaryRequest(auth())).toThrow(
      "quarantined or draining",
    );

    await activate(value);
    const release = value.acquireOrdinaryRequest(auth());
    expect(value.snapshotForTesting()).toMatchObject({
      phase: "accepting",
      activeRequests: 1,
      activeSessions: 0,
    });
    release();
    release();
    expect(value.snapshotForTesting().activeRequests).toBe(0);
  });

  test("atomically rejects new activity after drain begins and waits for existing activity", async () => {
    const value = fence();
    await activate(value);
    const releaseRequest = value.acquireOrdinaryRequest(auth());
    const releaseSession = value.acquireOrdinarySession(auth());

    value.beginDrain(IDENTITY);
    expect(() => value.acquireOrdinaryRequest(auth())).toThrow(
      "quarantined or draining",
    );
    await expect(
      value.withDrainingMutation(IDENTITY, async () => "unsafe"),
    ).rejects.toThrow("zero active tenant requests and sessions");

    releaseRequest();
    releaseSession();
    await expect(
      value.withDrainingMutation(IDENTITY, async (proof) => proof),
    ).resolves.toEqual({
      tenant: IDENTITY.tenant,
      workerStackId: IDENTITY.workerStackId,
      generation: IDENTITY.generation,
      leaseDraining: true,
      activeTenantRequestCount: 0,
      activeTenantProcessCount: 0,
      activeTenantSessionCount: 0,
    });
  });

  test("fails closed without an authoritative process and background-session probe", async () => {
    const value = new PooledRuntimeDrainFence(() => true, null);
    value.beginAssignmentMutation(IDENTITY);
    await expect(
      value.proveAssignmentMutationQuiescent(IDENTITY),
    ).rejects.toThrow("runtime-wide quiescence probe");
    value.quarantineAssignment(IDENTITY);
    expect(value.snapshotForTesting().phase).toBe("quarantined");
  });

  test("rejects stale generations and tenant swaps across sequential reuse", async () => {
    const value = fence();
    await activate(value);
    value.beginDrain(IDENTITY);
    await value.withDrainingMutation(IDENTITY, async () => {
      value.markSanitized(IDENTITY);
    });

    const next = {
      tenant: { orgId: "org-2", assistantId: "assistant-2" },
      workerStackId: IDENTITY.workerStackId,
      generation: 5,
    };
    value.beginAssignmentMutation(next);
    await value.proveAssignmentMutationQuiescent(next);
    value.activateAssignment(next);

    expect(() => value.acquireOrdinaryRequest(auth(IDENTITY))).toThrow(
      "does not match the active assignment",
    );
    expect(() =>
      value.beginAssignmentMutation({
        ...next,
        generation: IDENTITY.generation,
      }),
    ).toThrow();
  });

  test("quarantines a failed restore and permits only an exact-generation retry", async () => {
    const value = fence();
    value.beginAssignmentMutation(IDENTITY);
    value.quarantineAssignment(IDENTITY);

    expect(() =>
      value.beginAssignmentMutation({
        ...IDENTITY,
        tenant: { ...IDENTITY.tenant, orgId: "org-2" },
      }),
    ).toThrow("stale or the prior tenant was not sanitized");
    value.beginAssignmentMutation(IDENTITY);
    await value.proveAssignmentMutationQuiescent(IDENTITY);
    value.activateAssignment(IDENTITY);
    expect(value.snapshotForTesting().phase).toBe("accepting");
  });
});
