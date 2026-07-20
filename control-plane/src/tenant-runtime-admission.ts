import type { Database } from "bun:sqlite";

type EnvLike = Record<string, string | undefined>;

export type TenantRuntimeTrafficMode = "active" | "read_only" | "suspended";
export type TenantRuntimeRequestClass = "request" | "turn" | "stream";

export interface TenantRuntimeIdentity {
  organizationId: string;
  userId: string;
  assistantId: string;
}

export interface TenantRuntimeRequestKind {
  requestClass: TenantRuntimeRequestClass;
  mutation: boolean;
}

export interface TenantRuntimeAdmissionConfig {
  enabled: boolean;
  trafficMode: TenantRuntimeTrafficMode;
  maxConcurrentRequests: number;
  maxConcurrentTurns: number;
  requestsPerWindow: number;
  rateWindowMs: number;
  admissionTtlMs: number;
}

export interface TenantRuntimePolicy {
  organization_id: string;
  assistant_id: string;
  status: "active" | "suspended";
  max_concurrent_requests: number | null;
  max_concurrent_turns: number | null;
  requests_per_window: number | null;
  operator_note: string | null;
  updated_by: string;
  updated_at: string;
}

export type TenantRuntimeAdmissionResult =
  | { status: "bypassed" }
  | {
      status: "admitted";
      token: string;
      expiresAt: number;
      requestClass: TenantRuntimeRequestClass;
    }
  | {
      status: "rejected";
      reason:
        | "invalid_tenant"
        | "global_suspension"
        | "global_read_only"
        | "tenant_suspended"
        | "token_replay"
        | "rate_limited"
        | "request_concurrency_exhausted"
        | "turn_concurrency_exhausted";
      retryAfterMs: number | null;
    };

export type TenantRuntimeAdmissionMutationResult =
  | { status: "updated"; expiresAt?: number }
  | { status: "not_found" }
  | { status: "identity_mismatch" };

interface TenantRuntimeAdmissionRow {
  token: string;
  organization_id: string;
  user_id: string;
  assistant_id: string;
  request_class: TenantRuntimeRequestClass;
  acquired_at: number;
  expires_at: number;
  released_at: number | null;
}

interface EffectiveLimits {
  maxConcurrentRequests: number;
  maxConcurrentTurns: number;
  requestsPerWindow: number;
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("Boolean environment values must use true or false.");
}

function positiveIntegerEnv(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function trafficModeEnv(value: string | undefined): TenantRuntimeTrafficMode {
  const normalized = value?.trim().toLowerCase() || "active";
  if (
    normalized === "active" ||
    normalized === "read_only" ||
    normalized === "suspended"
  ) {
    return normalized;
  }
  throw new Error(
    "WORKLIN_TENANT_RUNTIME_TRAFFIC_MODE must be active, read_only, or suspended.",
  );
}

export function tenantRuntimeAdmissionConfigFromEnv(
  rawEnv: EnvLike,
): TenantRuntimeAdmissionConfig {
  return {
    enabled: booleanEnv(
      rawEnv.WORKLIN_TENANT_RUNTIME_ADMISSION_ENABLED,
      false,
    ),
    trafficMode: trafficModeEnv(
      rawEnv.WORKLIN_TENANT_RUNTIME_TRAFFIC_MODE,
    ),
    maxConcurrentRequests: positiveIntegerEnv(
      "WORKLIN_TENANT_MAX_CONCURRENT_REQUESTS",
      rawEnv.WORKLIN_TENANT_MAX_CONCURRENT_REQUESTS,
      8,
    ),
    maxConcurrentTurns: positiveIntegerEnv(
      "WORKLIN_TENANT_MAX_CONCURRENT_TURNS",
      rawEnv.WORKLIN_TENANT_MAX_CONCURRENT_TURNS,
      2,
    ),
    requestsPerWindow: positiveIntegerEnv(
      "WORKLIN_TENANT_REQUESTS_PER_WINDOW",
      rawEnv.WORKLIN_TENANT_REQUESTS_PER_WINDOW,
      120,
    ),
    rateWindowMs: positiveIntegerEnv(
      "WORKLIN_TENANT_RATE_WINDOW_MS",
      rawEnv.WORKLIN_TENANT_RATE_WINDOW_MS,
      60_000,
    ),
    admissionTtlMs: positiveIntegerEnv(
      "WORKLIN_TENANT_ADMISSION_TTL_MS",
      rawEnv.WORKLIN_TENANT_ADMISSION_TTL_MS,
      10 * 60_000,
    ),
  };
}

export function ensureTenantRuntimeAdmissionSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_runtime_policies (
      organization_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'suspended')),
      max_concurrent_requests INTEGER
        CHECK(max_concurrent_requests IS NULL OR max_concurrent_requests >= 0),
      max_concurrent_turns INTEGER
        CHECK(max_concurrent_turns IS NULL OR max_concurrent_turns >= 0),
      requests_per_window INTEGER
        CHECK(requests_per_window IS NULL OR requests_per_window >= 0),
      operator_note TEXT,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(organization_id, assistant_id)
    );

    CREATE TABLE IF NOT EXISTS tenant_runtime_admissions (
      token TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      request_class TEXT NOT NULL
        CHECK(request_class IN ('request', 'turn', 'stream')),
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      released_at INTEGER,
      CHECK(expires_at > acquired_at)
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_runtime_admissions_active
      ON tenant_runtime_admissions(
        organization_id,
        user_id,
        assistant_id,
        expires_at
      )
      WHERE released_at IS NULL;

    CREATE TABLE IF NOT EXISTS tenant_runtime_rate_buckets (
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      window_started_at INTEGER NOT NULL,
      request_count INTEGER NOT NULL CHECK(request_count >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(
        organization_id,
        user_id,
        assistant_id,
        window_started_at
      )
    );
  `);
}

function isTenantIdentity(value: TenantRuntimeIdentity): boolean {
  return (
    value.organizationId.trim().length > 0 &&
    value.userId.trim().length > 0 &&
    value.assistantId.trim().length > 0
  );
}

function tenantExists(
  db: Database,
  identity: TenantRuntimeIdentity,
): boolean {
  return Boolean(
    db
      .query<
        { found: number },
        [string, string, string, string]
      >(
        `SELECT 1 AS found
         FROM assistants AS assistant
         JOIN organizations AS organization
           ON organization.id = assistant.org_id
          AND organization.user_id = assistant.user_id
         WHERE assistant.id = ?
           AND assistant.org_id = ?
           AND assistant.user_id = ?
           AND organization.user_id = ?`,
      )
      .get(
        identity.assistantId,
        identity.organizationId,
        identity.userId,
        identity.userId,
      ),
  );
}

function getPolicy(
  db: Database,
  identity: TenantRuntimeIdentity,
): TenantRuntimePolicy | null {
  return (
    db
      .query<
        TenantRuntimePolicy,
        [string, string]
      >(
        `SELECT *
         FROM tenant_runtime_policies
         WHERE organization_id = ? AND assistant_id = ?`,
      )
      .get(identity.organizationId, identity.assistantId) ?? null
  );
}

export function readTenantRuntimePolicy(
  db: Database,
  identity: TenantRuntimeIdentity,
): TenantRuntimePolicy | null {
  if (!isTenantIdentity(identity) || !tenantExists(db, identity)) return null;
  return getPolicy(db, identity);
}

function effectiveLimits(
  config: TenantRuntimeAdmissionConfig,
  policy: TenantRuntimePolicy | null,
): EffectiveLimits {
  return {
    maxConcurrentRequests:
      policy?.max_concurrent_requests ?? config.maxConcurrentRequests,
    maxConcurrentTurns:
      policy?.max_concurrent_turns ?? config.maxConcurrentTurns,
    requestsPerWindow:
      policy?.requests_per_window ?? config.requestsPerWindow,
  };
}

function activeAdmissionCount(
  db: Database,
  identity: TenantRuntimeIdentity,
  nowMs: number,
  requestClass?: TenantRuntimeRequestClass,
): number {
  if (requestClass) {
    return (
      db
        .query<
          { count: number },
          [string, string, string, number, TenantRuntimeRequestClass]
        >(
          `SELECT COUNT(*) AS count
           FROM tenant_runtime_admissions
           WHERE organization_id = ?
             AND user_id = ?
             AND assistant_id = ?
             AND released_at IS NULL
             AND expires_at > ?
             AND request_class = ?`,
        )
        .get(
          identity.organizationId,
          identity.userId,
          identity.assistantId,
          nowMs,
          requestClass,
        )?.count ?? 0
    );
  }
  return (
    db
      .query<
        { count: number },
        [string, string, string, number]
      >(
        `SELECT COUNT(*) AS count
         FROM tenant_runtime_admissions
         WHERE organization_id = ?
           AND user_id = ?
           AND assistant_id = ?
           AND released_at IS NULL
           AND expires_at > ?`,
      )
      .get(
        identity.organizationId,
        identity.userId,
        identity.assistantId,
        nowMs,
      )?.count ?? 0
  );
}

function nextAdmissionExpiry(
  db: Database,
  identity: TenantRuntimeIdentity,
  nowMs: number,
  requestClass?: TenantRuntimeRequestClass,
): number | null {
  const row = requestClass
    ? db
        .query<
          { expires_at: number | null },
          [string, string, string, number, TenantRuntimeRequestClass]
        >(
          `SELECT MIN(expires_at) AS expires_at
           FROM tenant_runtime_admissions
           WHERE organization_id = ?
             AND user_id = ?
             AND assistant_id = ?
             AND released_at IS NULL
             AND expires_at > ?
             AND request_class = ?`,
        )
        .get(
          identity.organizationId,
          identity.userId,
          identity.assistantId,
          nowMs,
          requestClass,
        )
    : db
        .query<
          { expires_at: number | null },
          [string, string, string, number]
        >(
          `SELECT MIN(expires_at) AS expires_at
           FROM tenant_runtime_admissions
           WHERE organization_id = ?
             AND user_id = ?
             AND assistant_id = ?
             AND released_at IS NULL
             AND expires_at > ?`,
        )
        .get(
          identity.organizationId,
          identity.userId,
          identity.assistantId,
          nowMs,
        );
  return typeof row?.expires_at === "number" ? row.expires_at : null;
}

function retryAfterExpiry(expiresAt: number | null, nowMs: number): number {
  return Math.max(1, (expiresAt ?? nowMs + 1_000) - nowMs);
}

export function classifyTenantRuntimeRequest(
  method: string,
  pathname: string,
): TenantRuntimeRequestKind {
  const normalizedMethod = method.toUpperCase();
  const mutation =
    normalizedMethod !== "GET" &&
    normalizedMethod !== "HEAD" &&
    normalizedMethod !== "OPTIONS";

  if (
    normalizedMethod === "GET" &&
    /\/events\/?$/.test(pathname)
  ) {
    return { requestClass: "stream", mutation: false };
  }
  if (
    normalizedMethod === "POST" &&
    /\/(?:messages|btw|inference\/send|tasks\/run|tasks\/queue\/run|workflows\/runs|live-voice\/providers\/chat\/completions)\/?$/.test(
      pathname,
    )
  ) {
    return { requestClass: "turn", mutation: true };
  }
  return { requestClass: "request", mutation };
}

export function acquireTenantRuntimeAdmission(
  db: Database,
  config: TenantRuntimeAdmissionConfig,
  identity: TenantRuntimeIdentity,
  kind: TenantRuntimeRequestKind,
  token: string,
  nowMs: number,
  nowIso: () => string,
): TenantRuntimeAdmissionResult {
  if (!config.enabled) return { status: "bypassed" };
  if (!isTenantIdentity(identity) || token.trim().length === 0) {
    return {
      status: "rejected",
      reason: "invalid_tenant",
      retryAfterMs: null,
    };
  }

  return db
    .transaction((): TenantRuntimeAdmissionResult => {
      if (!tenantExists(db, identity)) {
        return {
          status: "rejected",
          reason: "invalid_tenant",
          retryAfterMs: null,
        };
      }
      if (config.trafficMode === "suspended") {
        return {
          status: "rejected",
          reason: "global_suspension",
          retryAfterMs: null,
        };
      }
      if (config.trafficMode === "read_only" && kind.mutation) {
        return {
          status: "rejected",
          reason: "global_read_only",
          retryAfterMs: null,
        };
      }

      const policy = getPolicy(db, identity);
      if (policy?.status === "suspended") {
        return {
          status: "rejected",
          reason: "tenant_suspended",
          retryAfterMs: null,
        };
      }
      if (getAdmission(db, token)) {
        return {
          status: "rejected",
          reason: "token_replay",
          retryAfterMs: null,
        };
      }
      const limits = effectiveLimits(config, policy);
      const windowStartedAt =
        Math.floor(nowMs / config.rateWindowMs) * config.rateWindowMs;
      const windowCount =
        db
          .query<
            { request_count: number },
            [string, string, string, number]
          >(
            `SELECT request_count
             FROM tenant_runtime_rate_buckets
             WHERE organization_id = ?
               AND user_id = ?
               AND assistant_id = ?
               AND window_started_at = ?`,
          )
          .get(
            identity.organizationId,
            identity.userId,
            identity.assistantId,
            windowStartedAt,
          )?.request_count ?? 0;
      if (windowCount >= limits.requestsPerWindow) {
        return {
          status: "rejected",
          reason: "rate_limited",
          retryAfterMs: windowStartedAt + config.rateWindowMs - nowMs,
        };
      }

      const activeRequests = activeAdmissionCount(db, identity, nowMs);
      if (activeRequests >= limits.maxConcurrentRequests) {
        return {
          status: "rejected",
          reason: "request_concurrency_exhausted",
          retryAfterMs: retryAfterExpiry(
            nextAdmissionExpiry(db, identity, nowMs),
            nowMs,
          ),
        };
      }
      if (
        kind.requestClass === "turn" &&
        activeAdmissionCount(db, identity, nowMs, "turn") >=
          limits.maxConcurrentTurns
      ) {
        return {
          status: "rejected",
          reason: "turn_concurrency_exhausted",
          retryAfterMs: retryAfterExpiry(
            nextAdmissionExpiry(db, identity, nowMs, "turn"),
            nowMs,
          ),
        };
      }

      const expiresAt = nowMs + config.admissionTtlMs;
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
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        token,
        identity.organizationId,
        identity.userId,
        identity.assistantId,
        kind.requestClass,
        nowMs,
        expiresAt,
      );
      db.query(
        `INSERT INTO tenant_runtime_rate_buckets (
           organization_id,
           user_id,
           assistant_id,
           window_started_at,
           request_count,
           updated_at
         ) VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(
           organization_id,
           user_id,
           assistant_id,
           window_started_at
         ) DO UPDATE SET
           request_count = request_count + 1,
           updated_at = excluded.updated_at`,
      ).run(
        identity.organizationId,
        identity.userId,
        identity.assistantId,
        windowStartedAt,
        nowIso(),
      );

      return {
        status: "admitted",
        token,
        expiresAt,
        requestClass: kind.requestClass,
      };
    })
    .immediate();
}

function getAdmission(
  db: Database,
  token: string,
): TenantRuntimeAdmissionRow | null {
  return (
    db
      .query<
        TenantRuntimeAdmissionRow,
        [string]
      >("SELECT * FROM tenant_runtime_admissions WHERE token = ?")
      .get(token) ?? null
  );
}

function admissionMatches(
  row: TenantRuntimeAdmissionRow,
  identity: TenantRuntimeIdentity,
): boolean {
  return (
    row.organization_id === identity.organizationId &&
    row.user_id === identity.userId &&
    row.assistant_id === identity.assistantId
  );
}

export function renewTenantRuntimeAdmission(
  db: Database,
  config: TenantRuntimeAdmissionConfig,
  identity: TenantRuntimeIdentity,
  token: string,
  nowMs: number,
): TenantRuntimeAdmissionMutationResult {
  if (!config.enabled) return { status: "not_found" };
  return db
    .transaction((): TenantRuntimeAdmissionMutationResult => {
      const row = getAdmission(db, token);
      if (!row || row.released_at !== null || row.expires_at <= nowMs) {
        return { status: "not_found" };
      }
      if (!admissionMatches(row, identity)) {
        return { status: "identity_mismatch" };
      }
      const expiresAt = nowMs + config.admissionTtlMs;
      db.query(
        `UPDATE tenant_runtime_admissions
         SET expires_at = ?
         WHERE token = ? AND released_at IS NULL`,
      ).run(expiresAt, token);
      return { status: "updated", expiresAt };
    })
    .immediate();
}

export function releaseTenantRuntimeAdmission(
  db: Database,
  config: TenantRuntimeAdmissionConfig,
  identity: TenantRuntimeIdentity,
  token: string,
  nowMs: number,
): TenantRuntimeAdmissionMutationResult {
  if (!config.enabled) return { status: "not_found" };
  return db
    .transaction((): TenantRuntimeAdmissionMutationResult => {
      const row = getAdmission(db, token);
      if (!row || row.released_at !== null) return { status: "not_found" };
      if (!admissionMatches(row, identity)) {
        return { status: "identity_mismatch" };
      }
      db.query(
        `UPDATE tenant_runtime_admissions
         SET released_at = ?
         WHERE token = ? AND released_at IS NULL`,
      ).run(nowMs, token);
      return { status: "updated" };
    })
    .immediate();
}

export function setTenantRuntimePolicy(
  db: Database,
  identity: TenantRuntimeIdentity,
  policy: {
    status: TenantRuntimePolicy["status"];
    maxConcurrentRequests?: number | null;
    maxConcurrentTurns?: number | null;
    requestsPerWindow?: number | null;
    operatorNote?: string | null;
    updatedBy: string;
  },
  nowIso: () => string,
): TenantRuntimePolicy {
  if (!isTenantIdentity(identity) || !tenantExists(db, identity)) {
    throw new Error("Tenant runtime policy identity is invalid.");
  }
  if (!policy.updatedBy.trim()) {
    throw new Error("Tenant runtime policy requires an operator identity.");
  }
  for (const [name, value] of [
    ["maxConcurrentRequests", policy.maxConcurrentRequests],
    ["maxConcurrentTurns", policy.maxConcurrentTurns],
    ["requestsPerWindow", policy.requestsPerWindow],
  ] as const) {
    if (value !== undefined && value !== null) {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer or null.`);
      }
    }
  }

  const current = getPolicy(db, identity);
  const updatedAt = nowIso();
  db.query(
    `INSERT INTO tenant_runtime_policies (
       organization_id,
       assistant_id,
       status,
       max_concurrent_requests,
       max_concurrent_turns,
       requests_per_window,
       operator_note,
       updated_by,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(organization_id, assistant_id) DO UPDATE SET
       status = excluded.status,
       max_concurrent_requests = excluded.max_concurrent_requests,
       max_concurrent_turns = excluded.max_concurrent_turns,
       requests_per_window = excluded.requests_per_window,
       operator_note = excluded.operator_note,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).run(
    identity.organizationId,
    identity.assistantId,
    policy.status,
    policy.maxConcurrentRequests === undefined
      ? (current?.max_concurrent_requests ?? null)
      : policy.maxConcurrentRequests,
    policy.maxConcurrentTurns === undefined
      ? (current?.max_concurrent_turns ?? null)
      : policy.maxConcurrentTurns,
    policy.requestsPerWindow === undefined
      ? (current?.requests_per_window ?? null)
      : policy.requestsPerWindow,
    policy.operatorNote === undefined
      ? (current?.operator_note ?? null)
      : policy.operatorNote,
    policy.updatedBy,
    updatedAt,
  );
  return getPolicy(db, identity)!;
}

export function pruneTenantRuntimeAdmissionHistory(
  db: Database,
  beforeMs: number,
): { admissions: number; rateBuckets: number } {
  const admissions = db
    .query(
      `DELETE FROM tenant_runtime_admissions
       WHERE (released_at IS NOT NULL AND released_at < ?)
          OR expires_at < ?`,
    )
    .run(beforeMs, beforeMs).changes;
  const rateBuckets = db
    .query(
      `DELETE FROM tenant_runtime_rate_buckets
       WHERE window_started_at < ?`,
    )
    .run(beforeMs).changes;
  return { admissions, rateBuckets };
}
