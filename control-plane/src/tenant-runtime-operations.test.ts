import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import type { RuntimeWorkerCapacityTelemetry } from "./runtime-worker-dispatcher.js";
import { ensureTenantRuntimeAdmissionSchema } from "./tenant-runtime-admission.js";
import {
  ensureTenantRuntimeOperationsSchema,
  evaluateTenantIdleSuspension,
  guardTenantStorageOperation,
  persistRuntimeCapacityAlert,
  planTenantIdleSuspension,
  readRuntimeCapacityAlerts,
  readTenantIdleSuspensionActions,
  readTenantRuntimeUsage,
  recordTenantRuntimeUsage,
  recordTrustedTenantStorageObservation,
  releaseTenantStorageReservation,
  setTenantRuntimeStorageQuota,
  tenantRuntimeOperationsConfigFromEnv,
  type TenantRuntimeOperationsConfig,
} from "./tenant-runtime-operations.js";

const databases: Database[] = [];
const NOW = 2_000_000_000_000;
const NOW_ISO = () => "2033-05-18T03:33:20.000Z";

const TENANT_A = {
  organizationId: "org-a",
  userId: "user-a",
  assistantId: "assistant-a",
};
const TENANT_B = {
  organizationId: "org-b",
  userId: "user-b",
  assistantId: "assistant-b",
};
const STOLEN_TENANT_A = {
  organizationId: "org-a",
  userId: "user-b",
  assistantId: "assistant-a",
};

const ENABLED_CONFIG: TenantRuntimeOperationsConfig = {
  enabled: true,
  storageQuotaEnforcementEnabled: true,
  defaultStorageQuotaBytes: 100,
  storageObservationMaxAgeMs: 10_000,
  storageReservationTtlMs: 5_000,
  usageMetricsEnabled: true,
  usageBucketMs: 60_000,
  idleSuspensionEnabled: true,
  idleAfterMs: 1_000,
  capacityAlertsEnabled: true,
  minimumAvailableWorkerCapacity: 1,
  capacityAlertDedupWindowMs: 60_000,
};

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function createDatabase(options: { workerTelemetry?: boolean } = {}): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );
    CREATE TABLE assistants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      org_id TEXT NOT NULL
    );
    INSERT INTO users (id) VALUES ('user-a'), ('user-b');
    INSERT INTO organizations (id, user_id)
      VALUES ('org-a', 'user-a'), ('org-b', 'user-b');
    INSERT INTO assistants (id, user_id, org_id)
      VALUES
        ('assistant-a', 'user-a', 'org-a'),
        ('assistant-b', 'user-b', 'org-b');
  `);
  ensureTenantRuntimeAdmissionSchema(db);
  ensureTenantRuntimeOperationsSchema(db);
  if (options.workerTelemetry !== false) {
    db.exec(`
      CREATE TABLE runtime_worker_leases (
        runtime_stack_id TEXT PRIMARY KEY,
        assistant_id TEXT,
        org_id TEXT,
        lease_token TEXT UNIQUE,
        lease_expires_at INTEGER,
        acquired_at INTEGER,
        released_at INTEGER,
        sanitized_at INTEGER,
        updated_at TEXT NOT NULL
      );
    `);
  }
  return db;
}

function leaseWorker(
  db: Database,
  identity: typeof TENANT_A,
  workerStackId: string,
  leaseToken: string,
  expiresAt = NOW + 10_000,
): void {
  db.query(
    `INSERT INTO runtime_worker_leases (
       runtime_stack_id,
       assistant_id,
       org_id,
       lease_token,
       lease_expires_at,
       acquired_at,
       released_at,
       sanitized_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(
    workerStackId,
    identity.assistantId,
    identity.organizationId,
    leaseToken,
    expiresAt,
    NOW - 1_000,
    NOW_ISO(),
  );
}

function observeStorage(
  db: Database,
  identity: typeof TENANT_A,
  options: {
    id?: string;
    worker?: string;
    token?: string;
    settledReservationToken?: string;
    bytes?: number;
    observedAt?: number;
    now?: number;
  } = {},
) {
  return recordTrustedTenantStorageObservation(
    db,
    ENABLED_CONFIG,
    identity,
    {
      observationId: options.id ?? "observation-a",
      workerStackId: options.worker ?? "worker-a",
      leaseToken: options.token ?? "lease-a-secret",
      settledReservationToken: options.settledReservationToken,
      source: "runtime_workspace_scan",
      observedBytes: options.bytes ?? 60,
      observedAtMs: options.observedAt ?? NOW - 100,
    },
    options.now ?? NOW,
    NOW_ISO,
  );
}

function telemetry(
  overrides: Partial<RuntimeWorkerCapacityTelemetry> = {},
): RuntimeWorkerCapacityTelemetry {
  return {
    state: "available",
    configuredWorkerCount: 4,
    readyWorkerCount: 4,
    unhealthyWorkerCount: 0,
    missingWorkerCount: 0,
    activeLeaseCount: 1,
    unregisteredActiveLeaseCount: 0,
    boundIdleWorkerCount: 0,
    unboundReadyWorkerCount: 3,
    maxConcurrentLeases: 4,
    availableNewAssistantCapacity: 3,
    ...overrides,
  };
}

describe("tenant runtime operations config", () => {
  test("keeps every new operation inert by default", () => {
    expect(tenantRuntimeOperationsConfigFromEnv({})).toEqual({
      enabled: false,
      storageQuotaEnforcementEnabled: false,
      defaultStorageQuotaBytes: 1_073_741_824,
      storageObservationMaxAgeMs: 900_000,
      storageReservationTtlMs: 600_000,
      usageMetricsEnabled: false,
      usageBucketMs: 3_600_000,
      idleSuspensionEnabled: false,
      idleAfterMs: 1_800_000,
      capacityAlertsEnabled: false,
      minimumAvailableWorkerCapacity: 1,
      capacityAlertDedupWindowMs: 300_000,
    });
    expect(() =>
      tenantRuntimeOperationsConfigFromEnv({
        WORKLIN_TENANT_RUNTIME_OPERATIONS_ENABLED: "sometimes",
      }),
    ).toThrow("must use true or false");
    expect(() =>
      tenantRuntimeOperationsConfigFromEnv({
        WORKLIN_TENANT_STORAGE_QUOTA_BYTES: "0",
      }),
    ).toThrow("positive safe integer");
  });

  test("does not persist or enforce while disabled", () => {
    const db = createDatabase();
    leaseWorker(db, TENANT_A, "worker-a", "lease-a-secret");
    const disabled = tenantRuntimeOperationsConfigFromEnv({});

    expect(
      recordTrustedTenantStorageObservation(
        db,
        disabled,
        TENANT_A,
        {
          observationId: "disabled-observation",
          workerStackId: "worker-a",
          leaseToken: "lease-a-secret",
          source: "runtime_state_export",
          observedBytes: 90,
          observedAtMs: NOW,
        },
        NOW,
        NOW_ISO,
      ),
    ).toEqual({ status: "bypassed" });
    expect(
      guardTenantStorageOperation(
        db,
        disabled,
        TENANT_A,
        {
          effect: "may_increase",
          reservationToken: "disabled-reservation",
          requestedBytes: 1_000,
        },
        NOW,
      ),
    ).toEqual({ status: "bypassed" });
    expect(
      db
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM tenant_runtime_storage_observations")
        .get()?.count,
    ).toBe(0);
  });
});

describe("tenant storage quota enforcement", () => {
  test("accepts only observations bound to the active tenant worker lease", () => {
    const db = createDatabase();
    leaseWorker(db, TENANT_A, "worker-a", "lease-a-secret");
    leaseWorker(db, TENANT_B, "worker-b", "lease-b-secret");

    expect(observeStorage(db, STOLEN_TENANT_A)).toEqual({
      status: "rejected",
      reason: "invalid_tenant",
    });
    expect(
      observeStorage(db, TENANT_A, {
        worker: "worker-b",
        token: "lease-b-secret",
      }),
    ).toEqual({ status: "rejected", reason: "untrusted_observation" });
    expect(
      recordTrustedTenantStorageObservation(
        db,
        ENABLED_CONFIG,
        TENANT_A,
        {
          observationId: "bad-source",
          workerStackId: "worker-a",
          leaseToken: "lease-a-secret",
          source: "client_reported" as never,
          observedBytes: 60,
          observedAtMs: NOW,
        },
        NOW,
        NOW_ISO,
      ),
    ).toEqual({ status: "rejected", reason: "invalid_observation" });

    expect(observeStorage(db, TENANT_A)).toEqual({
      status: "recorded",
      replayed: false,
      observedBytes: 60,
      quotaBytes: 100,
      withinQuota: true,
    });
    expect(observeStorage(db, TENANT_A)).toMatchObject({
      status: "recorded",
      replayed: true,
    });
    expect(observeStorage(db, TENANT_A, { bytes: 61 })).toEqual({
      status: "rejected",
      reason: "observation_conflict",
    });

    const persisted = db
      .query<
        Record<string, unknown>,
        []
      >("SELECT * FROM tenant_runtime_storage_observations")
      .all();
    expect(JSON.stringify(persisted)).not.toContain("observation-a");
    expect(JSON.stringify(persisted)).not.toContain("lease-a-secret");
  });

  test("reserves projected writes atomically and isolates tenant quotas", () => {
    const db = createDatabase();
    leaseWorker(db, TENANT_A, "worker-a", "lease-a-secret");
    leaseWorker(db, TENANT_B, "worker-b", "lease-b-secret");
    expect(observeStorage(db, TENANT_A).status).toBe("recorded");
    expect(
      observeStorage(db, TENANT_B, {
        id: "observation-b",
        worker: "worker-b",
        token: "lease-b-secret",
        bytes: 95,
      }).status,
    ).toBe("recorded");

    expect(
      guardTenantStorageOperation(
        db,
        ENABLED_CONFIG,
        TENANT_A,
        {
          effect: "may_increase",
          reservationToken: "reservation-a-1",
          requestedBytes: 30,
        },
        NOW,
      ),
    ).toEqual({ status: "allowed", reservationExpiresAt: NOW + 5_000 });
    expect(
      guardTenantStorageOperation(
        db,
        ENABLED_CONFIG,
        TENANT_A,
        {
          effect: "may_increase",
          reservationToken: "reservation-a-2",
          requestedBytes: 20,
        },
        NOW,
      ),
    ).toEqual({
      status: "rejected",
      reason: "storage_quota_exceeded",
      retryAfterMs: null,
    });
    expect(
      guardTenantStorageOperation(
        db,
        ENABLED_CONFIG,
        TENANT_B,
        {
          effect: "may_increase",
          reservationToken: "reservation-b-1",
          requestedBytes: 5,
        },
        NOW,
      ).status,
    ).toBe("allowed");

    expect(
      releaseTenantStorageReservation(
        db,
        ENABLED_CONFIG,
        TENANT_B,
        "reservation-a-1",
        NOW + 1,
      ),
    ).toBe("identity_mismatch");
    expect(
      releaseTenantStorageReservation(
        db,
        ENABLED_CONFIG,
        TENANT_A,
        "reservation-a-1",
        NOW + 1,
      ),
    ).toBe("released");
    expect(
      guardTenantStorageOperation(
        db,
        ENABLED_CONFIG,
        TENANT_A,
        {
          effect: "may_increase",
          reservationToken: "reservation-a-3",
          requestedBytes: 40,
        },
        NOW + 1,
      ).status,
    ).toBe("allowed");
  });

  test("counts expired committed reservations until a newer trusted scan", () => {
    const db = createDatabase();
    leaseWorker(db, TENANT_A, "worker-a", "lease-a-secret", NOW + 20_000);
    expect(observeStorage(db, TENANT_A).status).toBe("recorded");
    expect(
      guardTenantStorageOperation(
        db,
        ENABLED_CONFIG,
        TENANT_A,
        {
          effect: "may_increase",
          reservationToken: "committed-reservation",
          requestedBytes: 30,
        },
        NOW,
      ).status,
    ).toBe("allowed");

    expect(
      guardTenantStorageOperation(
        db,
        ENABLED_CONFIG,
        TENANT_A,
        {
          effect: "may_increase",
          reservationToken: "after-expiry",
          requestedBytes: 20,
        },
        NOW + 6_000,
      ),
    ).toMatchObject({
      status: "rejected",
      reason: "storage_quota_exceeded",
    });

    expect(
      observeStorage(db, TENANT_A, {
        id: "unknown-settlement",
        bytes: 90,
        observedAt: NOW + 6_000,
        now: NOW + 6_000,
        settledReservationToken: "not-a-reservation",
      }),
    ).toEqual({ status: "rejected", reason: "untrusted_observation" });

    expect(
      observeStorage(db, TENANT_A, {
        id: "post-write-observation",
        bytes: 90,
        observedAt: NOW + 6_000,
        now: NOW + 6_000,
        settledReservationToken: "committed-reservation",
      }).status,
    ).toBe("recorded");
    expect(
      guardTenantStorageOperation(
        db,
        ENABLED_CONFIG,
        TENANT_A,
        {
          effect: "may_increase",
          reservationToken: "after-reconciliation",
          requestedBytes: 10,
        },
        NOW + 6_000,
      ).status,
    ).toBe("allowed");
    expect(
      JSON.stringify(
        db
          .query<
            Record<string, unknown>,
            []
          >("SELECT * FROM tenant_runtime_storage_observations")
          .all(),
      ),
    ).not.toContain("committed-reservation");
  });

  test("a full trusted workspace scan settles only reservations already reflected in it", () => {
    const db = createDatabase();
    leaseWorker(db, TENANT_A, "worker-a", "lease-a-secret", NOW + 20_000);
    expect(observeStorage(db, TENANT_A).status).toBe("recorded");
    expect(
      guardTenantStorageOperation(
        db,
        ENABLED_CONFIG,
        TENANT_A,
        {
          effect: "may_increase",
          reservationToken: "before-full-scan",
          requestedBytes: 20,
        },
        NOW,
      ).status,
    ).toBe("allowed");

    expect(
      observeStorage(db, TENANT_A, {
        id: "full-workspace-scan",
        bytes: 70,
        observedAt: NOW + 1,
        now: NOW + 1,
      }),
    ).toMatchObject({
      status: "recorded",
      observedBytes: 70,
    });
    expect(
      db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count
           FROM tenant_runtime_storage_reservations
           WHERE released_at IS NULL`,
        )
        .get()?.count,
    ).toBe(0);

    expect(
      guardTenantStorageOperation(
        db,
        ENABLED_CONFIG,
        TENANT_A,
        {
          effect: "may_increase",
          reservationToken: "after-full-scan",
          requestedBytes: 10,
        },
        NOW + 2,
      ).status,
    ).toBe("allowed");
    expect(
      observeStorage(db, TENANT_A, {
        id: "full-workspace-scan",
        bytes: 70,
        observedAt: NOW + 1,
        now: NOW + 2,
      }),
    ).toMatchObject({ status: "recorded", replayed: true });
    expect(
      db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count
           FROM tenant_runtime_storage_reservations
           WHERE released_at IS NULL`,
        )
        .get()?.count,
    ).toBe(1);
  });

  test("fails closed on missing or stale measurements but permits cleanup", () => {
    const db = createDatabase();
    leaseWorker(db, TENANT_A, "worker-a", "lease-a-secret");

    expect(
      guardTenantStorageOperation(
        db,
        ENABLED_CONFIG,
        TENANT_A,
        {
          effect: "may_increase",
          reservationToken: "missing-observation",
          requestedBytes: 1,
        },
        NOW,
      ),
    ).toMatchObject({
      status: "rejected",
      reason: "storage_observation_missing",
    });
    expect(
      guardTenantStorageOperation(
        db,
        ENABLED_CONFIG,
        TENANT_A,
        { effect: "non_increasing" },
        NOW,
      ),
    ).toEqual({ status: "allowed" });

    expect(
      observeStorage(db, TENANT_A, { observedAt: NOW - 10_001 }).status,
    ).toBe("recorded");
    expect(
      guardTenantStorageOperation(
        db,
        ENABLED_CONFIG,
        TENANT_A,
        {
          effect: "may_increase",
          reservationToken: "stale-observation",
          requestedBytes: 1,
        },
        NOW,
      ),
    ).toMatchObject({
      status: "rejected",
      reason: "storage_observation_stale",
    });
  });

  test("supports a tenant-specific quota without permitting ownership swaps", () => {
    const db = createDatabase();
    expect(
      setTenantRuntimeStorageQuota(
        db,
        ENABLED_CONFIG,
        STOLEN_TENANT_A,
        200,
        "operator-1",
        NOW_ISO,
      ),
    ).toBe("invalid_tenant");
    expect(
      setTenantRuntimeStorageQuota(
        db,
        ENABLED_CONFIG,
        TENANT_A,
        200,
        "operator-1",
        NOW_ISO,
      ),
    ).toBe("updated");
    leaseWorker(db, TENANT_A, "worker-a", "lease-a-secret");
    expect(observeStorage(db, TENANT_A, { bytes: 150 })).toMatchObject({
      status: "recorded",
      quotaBytes: 200,
      withinQuota: true,
    });
  });
});

describe("privacy-safe tenant usage and idle planning", () => {
  test("aggregates scoped numeric usage without persisting raw event IDs", () => {
    const db = createDatabase();
    const first = recordTenantRuntimeUsage(
      db,
      ENABLED_CONFIG,
      TENANT_A,
      {
        eventId: "request-event-secret-a",
        metric: "request_count",
        value: 1,
        observedAtMs: NOW - 500,
      },
      NOW_ISO,
    );
    expect(first).toEqual({ status: "recorded", replayed: false });
    expect(
      recordTenantRuntimeUsage(
        db,
        ENABLED_CONFIG,
        TENANT_A,
        {
          eventId: "request-event-secret-a",
          metric: "request_count",
          value: 1,
          observedAtMs: NOW - 500,
        },
        NOW_ISO,
      ),
    ).toEqual({ status: "recorded", replayed: true });
    expect(
      recordTenantRuntimeUsage(
        db,
        ENABLED_CONFIG,
        TENANT_A,
        {
          eventId: "request-event-secret-a",
          metric: "turn_count",
          value: 1,
          observedAtMs: NOW - 500,
        },
        NOW_ISO,
      ),
    ).toEqual({ status: "rejected", reason: "event_conflict" });
    expect(
      recordTenantRuntimeUsage(
        db,
        ENABLED_CONFIG,
        STOLEN_TENANT_A,
        {
          eventId: "stolen-event",
          metric: "turn_count",
          value: 1,
          observedAtMs: NOW,
        },
        NOW_ISO,
      ),
    ).toEqual({ status: "rejected", reason: "invalid_tenant" });
    expect(
      recordTenantRuntimeUsage(
        db,
        ENABLED_CONFIG,
        TENANT_B,
        {
          eventId: "invalid-metric",
          metric: "prompt_text" as never,
          value: 1,
          observedAtMs: NOW,
        },
        NOW_ISO,
      ),
    ).toEqual({ status: "rejected", reason: "invalid_event" });

    expect(
      recordTenantRuntimeUsage(
        db,
        ENABLED_CONFIG,
        TENANT_B,
        {
          eventId: "large-stream",
          metric: "stream_ms",
          value: Number.MAX_SAFE_INTEGER,
          observedAtMs: NOW,
        },
        NOW_ISO,
      ).status,
    ).toBe("recorded");
    expect(
      recordTenantRuntimeUsage(
        db,
        ENABLED_CONFIG,
        TENANT_B,
        {
          eventId: "overflow-stream",
          metric: "stream_ms",
          value: 1,
          observedAtMs: NOW,
        },
        NOW_ISO,
      ),
    ).toEqual({ status: "rejected", reason: "invalid_event" });

    expect(readTenantRuntimeUsage(db, TENANT_A, 0)).toEqual([
      {
        bucketStartedAt: 1_999_999_980_000,
        requestCount: 1,
        turnCount: 0,
        streamMs: 0,
        workerMs: 0,
        sampleCount: 1,
      },
    ]);
    expect(readTenantRuntimeUsage(db, TENANT_B, 0)).toMatchObject([
      { streamMs: Number.MAX_SAFE_INTEGER, sampleCount: 1 },
    ]);
    expect(readTenantRuntimeUsage(db, STOLEN_TENANT_A, 0)).toBeNull();

    const rawEvents = db
      .query<
        Record<string, unknown>,
        []
      >("SELECT * FROM tenant_runtime_usage_events")
      .all();
    expect(JSON.stringify(rawEvents)).not.toContain("request-event-secret-a");
  });

  test("fails closed without activity or worker telemetry", () => {
    const db = createDatabase({ workerTelemetry: false });
    expect(
      evaluateTenantIdleSuspension(db, ENABLED_CONFIG, TENANT_A, NOW),
    ).toEqual({ status: "blocked", reason: "activity_unknown" });
    recordTenantRuntimeUsage(
      db,
      ENABLED_CONFIG,
      TENANT_A,
      {
        eventId: "old-request",
        metric: "request_count",
        value: 1,
        observedAtMs: NOW - 2_000,
      },
      NOW_ISO,
    );
    expect(
      evaluateTenantIdleSuspension(db, ENABLED_CONFIG, TENANT_A, NOW),
    ).toEqual({
      status: "blocked",
      reason: "worker_telemetry_unavailable",
    });
  });

  test("plans only quiescent tenants and cancels stale plans on activity", () => {
    const db = createDatabase();
    recordTenantRuntimeUsage(
      db,
      ENABLED_CONFIG,
      TENANT_A,
      {
        eventId: "old-request",
        metric: "request_count",
        value: 1,
        observedAtMs: NOW - 2_000,
      },
      NOW_ISO,
    );
    db.query(
      `INSERT INTO tenant_runtime_admissions (
         token,
         organization_id,
         user_id,
         assistant_id,
         request_class,
         acquired_at,
         expires_at,
         released_at
       ) VALUES ('active-request', 'org-a', 'user-a', 'assistant-a',
                 'request', ?, ?, NULL)`,
    ).run(NOW - 100, NOW + 1_000);
    expect(
      evaluateTenantIdleSuspension(db, ENABLED_CONFIG, TENANT_A, NOW),
    ).toEqual({ status: "blocked", reason: "active_request" });

    db.query(
      "UPDATE tenant_runtime_admissions SET released_at = ? WHERE token = 'active-request'",
    ).run(NOW);
    leaseWorker(db, TENANT_A, "worker-a", "active-worker", NOW + 1_000);
    expect(
      evaluateTenantIdleSuspension(db, ENABLED_CONFIG, TENANT_A, NOW),
    ).toEqual({ status: "blocked", reason: "active_worker_lease" });
    db.query(
      "UPDATE runtime_worker_leases SET lease_expires_at = ? WHERE runtime_stack_id = 'worker-a'",
    ).run(NOW - 1);

    expect(
      evaluateTenantIdleSuspension(db, ENABLED_CONFIG, TENANT_A, NOW),
    ).toEqual({
      status: "candidate",
      lastActivityAt: NOW - 2_000,
      eligibleAt: NOW - 1_000,
    });
    const planned = planTenantIdleSuspension(
      db,
      ENABLED_CONFIG,
      TENANT_A,
      NOW,
      NOW_ISO,
    );
    expect(planned).toMatchObject({
      status: "planned",
      replayed: false,
      action: { status: "pending" },
    });
    expect(
      planTenantIdleSuspension(db, ENABLED_CONFIG, TENANT_A, NOW, NOW_ISO),
    ).toMatchObject({ status: "planned", replayed: true });

    recordTenantRuntimeUsage(
      db,
      ENABLED_CONFIG,
      TENANT_A,
      {
        eventId: "new-request",
        metric: "turn_count",
        value: 1,
        observedAtMs: NOW + 1,
      },
      NOW_ISO,
    );
    expect(readTenantIdleSuspensionActions(db, TENANT_A)).toMatchObject([
      { status: "cancelled", cancelledAt: NOW_ISO() },
    ]);
    expect(readTenantIdleSuspensionActions(db, TENANT_B)).toEqual([]);
    expect(readTenantIdleSuspensionActions(db, STOLEN_TENANT_A)).toBeNull();
  });
});

describe("count-only runtime capacity alerts", () => {
  test("emits no alert for a healthy pool and remains disabled by default", () => {
    const db = createDatabase();
    expect(
      persistRuntimeCapacityAlert(
        db,
        tenantRuntimeOperationsConfigFromEnv({}),
        telemetry(),
        NOW,
        NOW_ISO,
      ),
    ).toEqual({ status: "bypassed" });
    expect(
      persistRuntimeCapacityAlert(
        db,
        ENABLED_CONFIG,
        telemetry(),
        NOW,
        NOW_ISO,
      ),
    ).toEqual({ status: "healthy" });
  });

  test("persists deduplicated count-only saturation alerts", () => {
    const db = createDatabase();
    const saturated = telemetry({
      state: "saturated",
      activeLeaseCount: 4,
      unboundReadyWorkerCount: 0,
      availableNewAssistantCapacity: 0,
    });
    const first = persistRuntimeCapacityAlert(
      db,
      ENABLED_CONFIG,
      saturated,
      NOW,
      NOW_ISO,
    );
    expect(first).toMatchObject({
      status: "alert",
      persisted: true,
      alert: {
        severity: "warning",
        code: "capacity_saturated",
        activeLeaseCount: 4,
        availableNewAssistantCapacity: 0,
      },
    });
    expect(
      persistRuntimeCapacityAlert(
        db,
        ENABLED_CONFIG,
        saturated,
        NOW + 1,
        NOW_ISO,
      ),
    ).toMatchObject({ status: "alert", persisted: false });

    const alerts = readRuntimeCapacityAlerts(db);
    expect(alerts).toHaveLength(1);
    const serialized = JSON.stringify(alerts);
    for (const forbidden of [
      "org-a",
      "user-a",
      "assistant-a",
      "worker-a",
      "api_key",
      "credential",
      "lease-a-secret",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(runtime_capacity_alerts)")
      .all()
      .map(({ name }) => name);
    expect(columns).not.toContain("organization_id");
    expect(columns).not.toContain("user_id");
    expect(columns).not.toContain("assistant_id");
    expect(columns).not.toContain("worker_stack_id");
  });

  test("raises a critical count-only alert for unregistered active leases", () => {
    const db = createDatabase();
    expect(
      persistRuntimeCapacityAlert(
        db,
        ENABLED_CONFIG,
        telemetry({ unregisteredActiveLeaseCount: 1 }),
        NOW,
        NOW_ISO,
      ),
    ).toMatchObject({
      status: "alert",
      alert: {
        severity: "critical",
        code: "unregistered_active_leases",
        unregisteredActiveLeaseCount: 1,
      },
    });
  });
});
