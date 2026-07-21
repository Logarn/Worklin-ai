import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import {
  acquireTenantRuntimeAdmission,
  classifyTenantRuntimeRequest,
  ensureTenantRuntimeAdmissionSchema,
  pruneTenantRuntimeAdmissionHistory,
  readTenantRuntimePolicy,
  releaseTenantRuntimeAdmission,
  renewTenantRuntimeAdmission,
  setTenantRuntimePolicy,
  tenantRuntimeAdmissionConfigFromEnv,
  type TenantRuntimeAdmissionConfig,
  type TenantRuntimeIdentity,
} from "./tenant-runtime-admission.js";

const databases: Database[] = [];
const NOW = 1_800_000_000_000;
const NOW_ISO = () => "2027-01-15T08:00:00.000Z";

const TENANT_A: TenantRuntimeIdentity = {
  organizationId: "org-a",
  userId: "user-a",
  assistantId: "assistant-a",
};
const TENANT_B: TenantRuntimeIdentity = {
  organizationId: "org-b",
  userId: "user-b",
  assistantId: "assistant-b",
};

const DEFAULT_CONFIG: TenantRuntimeAdmissionConfig = {
  enabled: true,
  trafficMode: "active",
  maxConcurrentRequests: 2,
  maxConcurrentTurns: 1,
  requestsPerWindow: 3,
  rateWindowMs: 60_000,
  admissionTtlMs: 10_000,
};

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function createDatabase(): Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY
    );
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
  return db;
}

function acquire(
  db: Database,
  identity: TenantRuntimeIdentity,
  token: string,
  options: {
    config?: TenantRuntimeAdmissionConfig;
    requestClass?: "request" | "turn" | "stream";
    mutation?: boolean;
    nowMs?: number;
  } = {},
) {
  return acquireTenantRuntimeAdmission(
    db,
    options.config ?? DEFAULT_CONFIG,
    identity,
    {
      requestClass: options.requestClass ?? "request",
      mutation: options.mutation ?? false,
    },
    token,
    options.nowMs ?? NOW,
    NOW_ISO,
  );
}

describe("tenant runtime admission", () => {
  test("is disabled by default and validates explicit limits", () => {
    expect(tenantRuntimeAdmissionConfigFromEnv({})).toEqual({
      enabled: false,
      trafficMode: "active",
      maxConcurrentRequests: 8,
      maxConcurrentTurns: 2,
      requestsPerWindow: 120,
      rateWindowMs: 60_000,
      admissionTtlMs: 600_000,
    });
    expect(() =>
      tenantRuntimeAdmissionConfigFromEnv({
        WORKLIN_TENANT_MAX_CONCURRENT_REQUESTS: "0",
      }),
    ).toThrow("must be a positive integer");
    expect(() =>
      tenantRuntimeAdmissionConfigFromEnv({
        WORKLIN_TENANT_RUNTIME_TRAFFIC_MODE: "unknown",
      }),
    ).toThrow("must be active, read_only, or suspended");
  });

  test("classifies turn and stream routes without treating reads as mutations", () => {
    expect(
      classifyTenantRuntimeRequest(
        "POST",
        "/v1/assistants/assistant-a/messages",
      ),
    ).toEqual({ requestClass: "turn", mutation: true });
    expect(
      classifyTenantRuntimeRequest(
        "GET",
        "/v1/assistants/assistant-a/events",
      ),
    ).toEqual({ requestClass: "stream", mutation: false });
    expect(
      classifyTenantRuntimeRequest(
        "GET",
        "/v1/assistants/assistant-a/conversations",
      ),
    ).toEqual({ requestClass: "request", mutation: false });
  });

  test("enforces request concurrency and releases capacity", () => {
    const db = createDatabase();
    expect(acquire(db, TENANT_A, "token-a-1").status).toBe("admitted");
    expect(acquire(db, TENANT_A, "token-a-2").status).toBe("admitted");
    expect(acquire(db, TENANT_A, "token-a-3")).toEqual({
      status: "rejected",
      reason: "request_concurrency_exhausted",
      retryAfterMs: 10_000,
    });

    expect(
      releaseTenantRuntimeAdmission(
        db,
        DEFAULT_CONFIG,
        TENANT_A,
        "token-a-1",
        NOW + 1,
      ),
    ).toEqual({ status: "updated" });
    expect(acquire(db, TENANT_A, "token-a-3").status).toBe("admitted");
  });

  test("enforces the turn cap independently from ordinary requests", () => {
    const db = createDatabase();
    expect(
      acquire(db, TENANT_A, "turn-a-1", {
        requestClass: "turn",
        mutation: true,
      }).status,
    ).toBe("admitted");
    expect(
      acquire(db, TENANT_A, "turn-a-2", {
        requestClass: "turn",
        mutation: true,
      }),
    ).toEqual({
      status: "rejected",
      reason: "turn_concurrency_exhausted",
      retryAfterMs: 10_000,
    });
    expect(acquire(db, TENANT_A, "request-a-1").status).toBe("admitted");
  });

  test("isolates tenant capacity and rejects cross-tenant token mutation", () => {
    const db = createDatabase();
    expect(acquire(db, TENANT_A, "token-a-1").status).toBe("admitted");
    expect(acquire(db, TENANT_A, "token-a-2").status).toBe("admitted");
    expect(acquire(db, TENANT_B, "token-b-1").status).toBe("admitted");

    expect(
      releaseTenantRuntimeAdmission(
        db,
        DEFAULT_CONFIG,
        TENANT_B,
        "token-a-1",
        NOW + 1,
      ),
    ).toEqual({ status: "identity_mismatch" });
    expect(
      renewTenantRuntimeAdmission(
        db,
        DEFAULT_CONFIG,
        TENANT_B,
        "token-a-1",
        NOW + 1,
      ),
    ).toEqual({ status: "identity_mismatch" });
  });

  test("rate limits admitted requests and resets at the next window", () => {
    const db = createDatabase();
    const config = { ...DEFAULT_CONFIG, requestsPerWindow: 2 };
    for (const token of ["rate-a-1", "rate-a-2"]) {
      expect(acquire(db, TENANT_A, token, { config }).status).toBe("admitted");
      expect(
        releaseTenantRuntimeAdmission(
          db,
          config,
          TENANT_A,
          token,
          NOW + 1,
        ).status,
      ).toBe("updated");
    }
    expect(acquire(db, TENANT_A, "rate-a-3", { config })).toEqual({
      status: "rejected",
      reason: "rate_limited",
      retryAfterMs: 60_000,
    });
    expect(
      acquire(db, TENANT_A, "rate-a-4", {
        config,
        nowMs: NOW + 60_000,
      }).status,
    ).toBe("admitted");
  });

  test("applies operator suspension and per-tenant overrides", () => {
    const db = createDatabase();
    const suspended = setTenantRuntimePolicy(
      db,
      TENANT_A,
      {
        status: "suspended",
        maxConcurrentRequests: 0,
        operatorNote: "support hold",
        updatedBy: "operator-1",
      },
      NOW_ISO,
    );
    expect(suspended.status).toBe("suspended");
    expect(readTenantRuntimePolicy(db, TENANT_A)).toEqual(suspended);
    expect(acquire(db, TENANT_A, "policy-a-1")).toEqual({
      status: "rejected",
      reason: "tenant_suspended",
      retryAfterMs: null,
    });
    expect(acquire(db, TENANT_B, "policy-b-1").status).toBe("admitted");

    setTenantRuntimePolicy(
      db,
      TENANT_A,
      {
        status: "active",
        updatedBy: "operator-1",
      },
      NOW_ISO,
    );
    expect(acquire(db, TENANT_A, "policy-a-2")).toEqual({
      status: "rejected",
      reason: "request_concurrency_exhausted",
      retryAfterMs: 1_000,
    });
  });

  test("supports global read-only and suspension controls", () => {
    const db = createDatabase();
    const readOnly = {
      ...DEFAULT_CONFIG,
      trafficMode: "read_only" as const,
    };
    expect(
      acquire(db, TENANT_A, "read-only-write", {
        config: readOnly,
        mutation: true,
      }),
    ).toEqual({
      status: "rejected",
      reason: "global_read_only",
      retryAfterMs: null,
    });
    expect(
      acquire(db, TENANT_A, "read-only-read", { config: readOnly }).status,
    ).toBe("admitted");

    const suspended = {
      ...DEFAULT_CONFIG,
      trafficMode: "suspended" as const,
    };
    expect(acquire(db, TENANT_B, "global-stop", { config: suspended })).toEqual(
      {
        status: "rejected",
        reason: "global_suspension",
        retryAfterMs: null,
      },
    );
  });

  test("rejects admission token replay after release", () => {
    const db = createDatabase();
    expect(acquire(db, TENANT_A, "replay-token").status).toBe("admitted");
    expect(
      releaseTenantRuntimeAdmission(
        db,
        DEFAULT_CONFIG,
        TENANT_A,
        "replay-token",
        NOW + 1,
      ).status,
    ).toBe("updated");
    expect(acquire(db, TENANT_A, "replay-token")).toEqual({
      status: "rejected",
      reason: "token_replay",
      retryAfterMs: null,
    });
  });

  test("renews live admissions, rejects expired admissions, and prunes history", () => {
    const db = createDatabase();
    expect(acquire(db, TENANT_A, "renew-token").status).toBe("admitted");
    expect(
      renewTenantRuntimeAdmission(
        db,
        DEFAULT_CONFIG,
        TENANT_A,
        "renew-token",
        NOW + 5_000,
      ),
    ).toEqual({ status: "updated", expiresAt: NOW + 15_000 });
    expect(
      renewTenantRuntimeAdmission(
        db,
        DEFAULT_CONFIG,
        TENANT_A,
        "renew-token",
        NOW + 15_000,
      ),
    ).toEqual({ status: "not_found" });
    expect(pruneTenantRuntimeAdmissionHistory(db, NOW + 20_000)).toEqual({
      admissions: 1,
      rateBuckets: 1,
    });
  });

  test("rejects identities that do not match the assistant owner and organization", () => {
    const db = createDatabase();
    const forged = { ...TENANT_A, organizationId: TENANT_B.organizationId };
    expect(acquire(db, forged, "forged-token")).toEqual({
      status: "rejected",
      reason: "invalid_tenant",
      retryAfterMs: null,
    });
    expect(() =>
      setTenantRuntimePolicy(
        db,
        forged,
        { status: "suspended", updatedBy: "operator-1" },
        NOW_ISO,
      ),
    ).toThrow("identity is invalid");
  });

  test("bypasses admission without touching tenant state when disabled", () => {
    const db = createDatabase();
    expect(
      acquire(db, { organizationId: "", userId: "", assistantId: "" }, "", {
        config: { ...DEFAULT_CONFIG, enabled: false },
      }),
    ).toEqual({ status: "bypassed" });
  });
});
