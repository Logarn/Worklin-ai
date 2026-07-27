import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireRuntimeWorkerCoordinatorOwnership,
  CONTROL_PLANE_EXPECTED_REPLICA_COUNT_ENV,
  ensureRuntimeWorkerCoordinatorOwnershipSchema,
  releaseRuntimeWorkerCoordinatorOwnership,
  renewRuntimeWorkerCoordinatorOwnership,
  RUNTIME_WORKER_COORDINATOR_DEPLOYMENT_ID_ENV,
  RUNTIME_WORKER_COORDINATOR_HEARTBEAT_MS_ENV,
  RuntimeWorkerCoordinatorOwnershipGuard,
  RUNTIME_WORKER_COORDINATOR_OWNERSHIP_TTL_MS_ENV,
  RUNTIME_WORKER_COORDINATOR_REPLICA_ID_ENV,
  runtimeWorkerCoordinatorOwnershipConfigFromEnv,
  runtimeWorkerCoordinatorOwnershipIsLive,
  RuntimeWorkerCoordinatorRequestAbortRegistry,
  type RuntimeWorkerCoordinatorOwnerIdentity,
} from "./runtime-worker-coordinator-ownership.js";

const NOW = 1_000_000;
const TTL = 15_000;
const NOW_ISO = () => "2026-07-21T00:00:00.000Z";
const ownerA: RuntimeWorkerCoordinatorOwnerIdentity = {
  ownerId: "process-a",
  deploymentId: "deployment-a",
  replicaId: "replica-a",
};
const ownerB: RuntimeWorkerCoordinatorOwnerIdentity = {
  ownerId: "process-b",
  deploymentId: "deployment-b",
  replicaId: "replica-b",
};

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePair(): [Database, Database] {
  const directory = mkdtempSync(join(tmpdir(), "worklin-coordinator-owner-"));
  tempDirectories.push(directory);
  const path = join(directory, "control-plane.sqlite");
  const first = new Database(path);
  first.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 0;");
  const second = new Database(path);
  second.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 0;");
  return [first, second];
}

function acquire(
  db: Database,
  identity: RuntimeWorkerCoordinatorOwnerIdentity,
  nowMs = NOW,
) {
  return acquireRuntimeWorkerCoordinatorOwnership(
    db,
    identity,
    nowMs,
    TTL,
    NOW_ISO,
  );
}

describe("runtime worker coordinator ownership configuration", () => {
  test("is inert while the pooled runtime is disabled", () => {
    expect(runtimeWorkerCoordinatorOwnershipConfigFromEnv({}, false)).toEqual({
      enabled: false,
      deploymentId: "",
      replicaId: "",
      ownershipTtlMs: 15_000,
      heartbeatMs: 5_000,
    });
  });

  test("requires an explicit one-replica attestation and process identity", () => {
    for (const count of [undefined, "0", "2", "1 "]) {
      expect(() =>
        runtimeWorkerCoordinatorOwnershipConfigFromEnv(
          {
            [CONTROL_PLANE_EXPECTED_REPLICA_COUNT_ENV]: count,
            [RUNTIME_WORKER_COORDINATOR_DEPLOYMENT_ID_ENV]: "deployment-a",
            [RUNTIME_WORKER_COORDINATOR_REPLICA_ID_ENV]: "replica-a",
          },
          true,
        ),
      ).toThrow();
    }

    expect(() =>
      runtimeWorkerCoordinatorOwnershipConfigFromEnv(
        { [CONTROL_PLANE_EXPECTED_REPLICA_COUNT_ENV]: "1" },
        true,
      ),
    ).toThrow(RUNTIME_WORKER_COORDINATOR_DEPLOYMENT_ID_ENV);

    expect(() =>
      runtimeWorkerCoordinatorOwnershipConfigFromEnv(
        {
          [CONTROL_PLANE_EXPECTED_REPLICA_COUNT_ENV]: "1",
          [RUNTIME_WORKER_COORDINATOR_DEPLOYMENT_ID_ENV]: "deployment-a",
        },
        true,
      ),
    ).toThrow(RUNTIME_WORKER_COORDINATOR_REPLICA_ID_ENV);

    expect(
      runtimeWorkerCoordinatorOwnershipConfigFromEnv(
        {
          [CONTROL_PLANE_EXPECTED_REPLICA_COUNT_ENV]: "1",
          [RUNTIME_WORKER_COORDINATOR_DEPLOYMENT_ID_ENV]: "deployment-a",
          [RUNTIME_WORKER_COORDINATOR_REPLICA_ID_ENV]: "replica-a",
        },
        true,
      ),
    ).toEqual({
      enabled: true,
      deploymentId: "deployment-a",
      replicaId: "replica-a",
      ownershipTtlMs: 15_000,
      heartbeatMs: 5_000,
    });
  });

  test("requires heartbeat headroom before ownership expiry", () => {
    expect(() =>
      runtimeWorkerCoordinatorOwnershipConfigFromEnv(
        {
          [CONTROL_PLANE_EXPECTED_REPLICA_COUNT_ENV]: "1",
          [RUNTIME_WORKER_COORDINATOR_DEPLOYMENT_ID_ENV]: "deployment-a",
          [RUNTIME_WORKER_COORDINATOR_REPLICA_ID_ENV]: "replica-a",
          [RUNTIME_WORKER_COORDINATOR_OWNERSHIP_TTL_MS_ENV]: "15000",
          [RUNTIME_WORKER_COORDINATOR_HEARTBEAT_MS_ENV]: "5001",
        },
        true,
      ),
    ).toThrow("at most one third");
  });
});

describe("runtime worker coordinator ownership", () => {
  test("admits only one owner across independent database connections", () => {
    const [first, second] = databasePair();
    try {
      const initial = acquire(first, ownerA);
      expect(initial.status).toBe("acquired");
      if (initial.status !== "acquired") throw new Error("unreachable");
      expect(initial.binding.epoch).toBe(1);
      expect(initial.takeover).toBe(false);

      expect(acquire(second, ownerB)).toEqual({
        status: "unavailable",
        reason: "active_owner",
        retryAfterMs: TTL,
      });
      expect(
        runtimeWorkerCoordinatorOwnershipIsLive(
          second,
          initial.binding,
          NOW,
        ),
      ).toBe(true);
    } finally {
      first.close();
      second.close();
    }
  });

  test("fails closed when another connection holds the immediate writer lock", () => {
    const [first, second] = databasePair();
    try {
      ensureRuntimeWorkerCoordinatorOwnershipSchema(first);
      first.exec("BEGIN IMMEDIATE");
      expect(acquire(second, ownerB)).toEqual({
        status: "unavailable",
        reason: "contended",
        retryAfterMs: null,
      });
      first.exec("ROLLBACK");
      expect(acquire(second, ownerB).status).toBe("acquired");
    } finally {
      first.close();
      second.close();
    }
  });

  test("renews only the exact live owner and rejects stale identities", () => {
    const db = new Database(":memory:");
    const initial = acquire(db, ownerA);
    expect(initial.status).toBe("acquired");
    if (initial.status !== "acquired") throw new Error("unreachable");

    const renewed = renewRuntimeWorkerCoordinatorOwnership(
      db,
      initial.binding,
      NOW + 1_000,
      TTL,
      NOW_ISO,
    );
    expect(renewed.status).toBe("renewed");
    if (renewed.status !== "renewed") throw new Error("unreachable");
    expect(renewed.binding).toEqual({
      ...initial.binding,
      heartbeatAtMs: NOW + 1_000,
      expiresAtMs: NOW + 1_000 + TTL,
    });

    expect(
      renewRuntimeWorkerCoordinatorOwnership(
        db,
        { ...renewed.binding, ownerId: "stale-process" },
        NOW + 2_000,
        TTL,
        NOW_ISO,
      ),
    ).toEqual({ status: "lost" });
    db.close();
  });

  test("reacquires idempotently for the same live process without changing epoch", () => {
    const db = new Database(":memory:");
    const initial = acquire(db, ownerA);
    if (initial.status !== "acquired") throw new Error("unreachable");

    const repeated = acquire(db, ownerA, NOW + 1_000);
    expect(repeated.status).toBe("acquired");
    if (repeated.status !== "acquired") throw new Error("unreachable");
    expect(repeated.takeover).toBe(false);
    expect(repeated.binding).toEqual({
      ...initial.binding,
      heartbeatAtMs: NOW + 1_000,
      expiresAtMs: NOW + 1_000 + TTL,
    });
    db.close();
  });

  test("permits takeover only at expiry and fences the old epoch", () => {
    const [first, second] = databasePair();
    try {
      const initial = acquire(first, ownerA);
      if (initial.status !== "acquired") throw new Error("unreachable");

      expect(acquire(second, ownerB, NOW + TTL - 1)).toEqual({
        status: "unavailable",
        reason: "active_owner",
        retryAfterMs: 1,
      });

      const takeover = acquire(second, ownerB, NOW + TTL);
      expect(takeover.status).toBe("acquired");
      if (takeover.status !== "acquired") throw new Error("unreachable");
      expect(takeover.takeover).toBe(true);
      expect(takeover.binding.epoch).toBe(2);
      expect(
        runtimeWorkerCoordinatorOwnershipIsLive(
          first,
          initial.binding,
          NOW + TTL,
        ),
      ).toBe(false);
      expect(
        renewRuntimeWorkerCoordinatorOwnership(
          first,
          initial.binding,
          NOW + TTL,
          TTL,
          NOW_ISO,
        ),
      ).toEqual({ status: "lost" });
      expect(
        releaseRuntimeWorkerCoordinatorOwnership(
          first,
          initial.binding,
          NOW + TTL,
          NOW_ISO,
        ),
      ).toEqual({ status: "lost" });
    } finally {
      first.close();
      second.close();
    }
  });

  test("releases with an exact CAS and preserves a monotonic epoch", () => {
    const db = new Database(":memory:");
    const initial = acquire(db, ownerA);
    if (initial.status !== "acquired") throw new Error("unreachable");

    expect(
      releaseRuntimeWorkerCoordinatorOwnership(
        db,
        { ...initial.binding, epoch: initial.binding.epoch + 1 },
        NOW + 1,
        NOW_ISO,
      ),
    ).toEqual({ status: "lost" });
    expect(
      releaseRuntimeWorkerCoordinatorOwnership(
        db,
        initial.binding,
        NOW + 1,
        NOW_ISO,
      ),
    ).toEqual({ status: "released", epoch: 1 });

    const next = acquire(db, ownerB, NOW + 2);
    expect(next.status).toBe("acquired");
    if (next.status !== "acquired") throw new Error("unreachable");
    expect(next.binding.epoch).toBe(2);
    expect(next.takeover).toBe(false);
    db.close();
  });

  test("guard fails closed after another process takes over", () => {
    const [first, second] = databasePair();
    try {
      let nowMs = NOW;
      const initial = acquire(first, ownerA, nowMs);
      if (initial.status !== "acquired") throw new Error("unreachable");
      const guard = new RuntimeWorkerCoordinatorOwnershipGuard(
        first,
        initial.binding,
        () => nowMs,
      );
      expect(guard.isLive()).toBe(true);

      nowMs += TTL;
      const takeover = acquire(second, ownerB, nowMs);
      expect(takeover.status).toBe("acquired");
      expect(guard.isLive()).toBe(false);
      expect(guard.renew(TTL, NOW_ISO)).toEqual({ status: "lost" });
      expect(guard.release(NOW_ISO)).toEqual({ status: "lost" });
    } finally {
      first.close();
      second.close();
    }
  });

  test("schema holds exactly one durable row across release cycles", () => {
    const db = new Database(":memory:");
    ensureRuntimeWorkerCoordinatorOwnershipSchema(db);
    const initial = acquire(db, ownerA);
    if (initial.status !== "acquired") throw new Error("unreachable");
    releaseRuntimeWorkerCoordinatorOwnership(
      db,
      initial.binding,
      NOW + 1,
      NOW_ISO,
    );
    acquire(db, ownerB, NOW + 2);

    expect(
      db
        .query<
          { count: number; max_epoch: number },
          []
        >(
          `SELECT COUNT(*) AS count, MAX(epoch) AS max_epoch
           FROM runtime_worker_coordinator_ownership`,
        )
        .get(),
    ).toEqual({ count: 1, max_epoch: 2 });
    db.close();
  });

  test("aborts every registered request exactly once when ownership is fenced", () => {
    const registry = new RuntimeWorkerCoordinatorRequestAbortRegistry();
    const first = new AbortController();
    const second = new AbortController();
    const unregisterFirst = registry.register(first);
    registry.register(second);
    unregisterFirst();
    expect(registry.activeCount).toBe(1);

    const reason = new Error("coordinator ownership lost");
    expect(registry.abortAll(reason)).toBe(1);
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(true);
    expect(second.signal.reason).toBe(reason);
    expect(registry.abortAll(reason)).toBe(0);
    expect(registry.activeCount).toBe(0);
  });
});
