import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";

export const RUNTIME_STACK_STATUSES = [
  "provisioning",
  "active",
  "failed",
  "suspended",
  "deleted",
] as const;

export type RuntimeStackStatus = (typeof RUNTIME_STACK_STATUSES)[number];

export interface AssistantRuntimeRow {
  id: string;
  user_id: string;
  org_id: string;
  runtime_stack_id?: string | null;
}

export interface RuntimeStackRow {
  id: string;
  org_id: string;
  assistant_id: string;
  status: RuntimeStackStatus;
  provider: string;
  gateway_url: string | null;
  public_ingress_url: string | null;
  workspace_volume_ref: string | null;
  service_ref: string | null;
  last_health_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RuntimeStackConfig {
  gatewayUrl: string;
  publicIngressUrl: string;
  requireIsolatedRuntime: boolean;
  allowLegacySharedRuntime: boolean;
  legacySharedRuntimeUserHashes: readonly string[];
  runtimeStackUrlTemplate: string | null;
  runtimeStackProvider: string;
  runtimeRoot: string | null;
}

type EnvLike = Record<string, string | undefined>;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function runtimeStackConfigFromEnv(
  rawEnv: EnvLike,
  gatewayUrl: string,
  publicIngressUrl: string,
): RuntimeStackConfig {
  const allowLegacySharedRuntime = boolEnv(
    rawEnv.WORKLIN_ALLOW_LEGACY_SHARED_RUNTIME,
    false,
  );
  const requireIsolatedRuntime = boolEnv(
    rawEnv.WORKLIN_REQUIRE_ISOLATED_RUNTIME,
    true,
  );
  const legacySharedRuntimeUserHashes = (
    rawEnv.WORKLIN_LEGACY_SHARED_RUNTIME_USER_HASHES ?? ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const template = rawEnv.WORKLIN_RUNTIME_STACK_URL_TEMPLATE?.trim() || null;
  return {
    gatewayUrl,
    publicIngressUrl,
    requireIsolatedRuntime,
    allowLegacySharedRuntime,
    legacySharedRuntimeUserHashes,
    runtimeStackUrlTemplate: template,
    runtimeStackProvider:
      rawEnv.WORKLIN_RUNTIME_STACK_PROVIDER?.trim() ||
      (template ? "static_template" : "railway"),
    runtimeRoot: rawEnv.WORKLIN_RUNTIME_ROOT?.trim() || null,
  };
}

function isLegacySharedRuntimeAllowedForAssistant(
  config: RuntimeStackConfig,
  assistant: AssistantRuntimeRow,
): boolean {
  const userHash = createHash("sha256")
    .update(assistant.user_id)
    .digest("hex");
  return (
    config.legacySharedRuntimeUserHashes.length === 0 ||
    config.legacySharedRuntimeUserHashes.includes(userHash)
  );
}

function tableColumns(db: Database, table: string): Set<string> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
  const rows = db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all();
  return new Set(rows.map((row) => row.name));
}

function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  ddl: string,
): void {
  if (tableColumns(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function ensureRuntimeStackSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_stacks (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('provisioning', 'active', 'failed', 'suspended', 'deleted')),
      provider TEXT NOT NULL,
      gateway_url TEXT,
      public_ingress_url TEXT,
      workspace_volume_ref TEXT,
      service_ref TEXT,
      last_health_status TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_stacks_org_status
      ON runtime_stacks(org_id, status);
    CREATE INDEX IF NOT EXISTS idx_runtime_stacks_assistant_status
      ON runtime_stacks(assistant_id, status);
    CREATE INDEX IF NOT EXISTS idx_assistants_user_created
      ON assistants(user_id, created_at);
  `);
  addColumnIfMissing(
    db,
    "assistants",
    "runtime_stack_id",
    "runtime_stack_id TEXT",
  );
  addColumnIfMissing(
    db,
    "assistants",
    "isolation_version",
    "isolation_version INTEGER NOT NULL DEFAULT 2",
  );
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_assistants_user_runtime
      ON assistants(user_id, runtime_stack_id);
  `);
}

export function getRuntimeStackForAssistant(
  db: Database,
  assistant: AssistantRuntimeRow,
): RuntimeStackRow | null {
  if (assistant.runtime_stack_id) {
    const byId = db
      .query<RuntimeStackRow, [string, string]>(
        "SELECT * FROM runtime_stacks WHERE id = ? AND assistant_id = ?",
      )
      .get(assistant.runtime_stack_id, assistant.id);
    if (byId) return byId;
  }
  return (
    db
      .query<RuntimeStackRow, [string]>(
        "SELECT * FROM runtime_stacks WHERE assistant_id = ?",
      )
      .get(assistant.id) ?? null
  );
}

function expandRuntimeStackUrlTemplate(
  template: string,
  assistant: AssistantRuntimeRow,
): string {
  return trimTrailingSlash(
    template
      .replaceAll("{assistantId}", encodeURIComponent(assistant.id))
      .replaceAll("{orgId}", encodeURIComponent(assistant.org_id))
      .replaceAll("{userId}", encodeURIComponent(assistant.user_id)),
  );
}

function nextRuntimeStackSeed(
  assistant: AssistantRuntimeRow,
  config: RuntimeStackConfig,
): Pick<
  RuntimeStackRow,
  | "status"
  | "provider"
  | "gateway_url"
  | "public_ingress_url"
  | "workspace_volume_ref"
  | "service_ref"
  | "last_health_status"
  | "last_error"
> {
  if (config.runtimeStackUrlTemplate) {
    return {
      status: "active",
      provider: config.runtimeStackProvider,
      gateway_url: expandRuntimeStackUrlTemplate(
        config.runtimeStackUrlTemplate,
        assistant,
      ),
      public_ingress_url: config.publicIngressUrl,
      workspace_volume_ref: null,
      service_ref: assistant.id,
      last_health_status: null,
      last_error: null,
    };
  }

  if (
    !config.requireIsolatedRuntime &&
    config.allowLegacySharedRuntime &&
    isLegacySharedRuntimeAllowedForAssistant(config, assistant)
  ) {
    return {
      status: "active",
      provider: "legacy_shared",
      gateway_url: config.gatewayUrl,
      public_ingress_url: config.publicIngressUrl,
      workspace_volume_ref: config.runtimeRoot,
      service_ref: "legacy-shared-runtime",
      last_health_status: null,
      last_error: null,
    };
  }

  return {
    status: "provisioning",
    provider: config.runtimeStackProvider,
    gateway_url: null,
    public_ingress_url: config.publicIngressUrl,
    workspace_volume_ref: null,
    service_ref: null,
    last_health_status: null,
    last_error: null,
  };
}

function recoverUnallocatedStackToLegacySharedRuntime(
  db: Database,
  assistant: AssistantRuntimeRow,
  stack: RuntimeStackRow,
  config: RuntimeStackConfig,
  nowIso: () => string,
): RuntimeStackRow {
  if (
    config.requireIsolatedRuntime ||
    !config.allowLegacySharedRuntime ||
    !isLegacySharedRuntimeAllowedForAssistant(config, assistant) ||
    config.runtimeStackUrlTemplate ||
    stack.provider !== "railway" ||
    (stack.status !== "failed" && stack.status !== "provisioning") ||
    stack.gateway_url !== null ||
    stack.service_ref !== null ||
    stack.workspace_volume_ref !== null
  ) {
    return stack;
  }

  db.query(`
    UPDATE runtime_stacks
    SET status = 'active',
        provider = 'legacy_shared',
        gateway_url = ?,
        public_ingress_url = ?,
        workspace_volume_ref = ?,
        service_ref = 'legacy-shared-runtime',
        last_health_status = NULL,
        last_error = NULL,
        updated_at = ?
    WHERE id = ?
      AND provider = 'railway'
      AND status IN ('failed', 'provisioning')
      AND gateway_url IS NULL
      AND service_ref IS NULL
      AND workspace_volume_ref IS NULL
  `).run(
    config.gatewayUrl,
    config.publicIngressUrl,
    config.runtimeRoot,
    nowIso(),
    stack.id,
  );

  return getRuntimeStackById(db, stack.id) ?? stack;
}

export function ensureRuntimeStackForAssistant(
  db: Database,
  assistant: AssistantRuntimeRow,
  config: RuntimeStackConfig,
  nowIso: () => string,
): RuntimeStackRow {
  const existing = getRuntimeStackForAssistant(db, assistant);
  if (existing) {
    if (assistant.runtime_stack_id !== existing.id) {
      db.query("UPDATE assistants SET runtime_stack_id = ? WHERE id = ?").run(
        existing.id,
        assistant.id,
      );
    }
    return recoverUnallocatedStackToLegacySharedRuntime(
      db,
      assistant,
      existing,
      config,
      nowIso,
    );
  }

  const timestamp = nowIso();
  const seed = nextRuntimeStackSeed(assistant, config);
  const stack: RuntimeStackRow = {
    id: "rt-" + randomUUID(),
    org_id: assistant.org_id,
    assistant_id: assistant.id,
    created_at: timestamp,
    updated_at: timestamp,
    ...seed,
  };
  db.query(`
    INSERT INTO runtime_stacks (
      id,
      org_id,
      assistant_id,
      status,
      provider,
      gateway_url,
      public_ingress_url,
      workspace_volume_ref,
      service_ref,
      last_health_status,
      last_error,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    stack.id,
    stack.org_id,
    stack.assistant_id,
    stack.status,
    stack.provider,
    stack.gateway_url,
    stack.public_ingress_url,
    stack.workspace_volume_ref,
    stack.service_ref,
    stack.last_health_status,
    stack.last_error,
    stack.created_at,
    stack.updated_at,
  );
  db.query("UPDATE assistants SET runtime_stack_id = ? WHERE id = ?").run(
    stack.id,
    assistant.id,
  );
  return stack;
}

export function getRuntimeStackById(
  db: Database,
  stackId: string,
): RuntimeStackRow | null {
  return (
    db
      .query<RuntimeStackRow, [string]>(
        "SELECT * FROM runtime_stacks WHERE id = ?",
      )
      .get(stackId) ?? null
  );
}

export function countAllocatedRuntimeServices(db: Database): number {
  return (
    db
      .query<{ count: number }, []>(`
        SELECT COUNT(*) AS count
        FROM runtime_stacks
        WHERE service_ref IS NOT NULL AND status != 'deleted'
      `)
      .get()?.count ?? 0
  );
}

export function markRuntimeStackProvisioning(
  db: Database,
  stackId: string,
  nowIso: () => string,
): void {
  db.query(`
    UPDATE runtime_stacks
    SET status = 'provisioning', last_error = NULL, updated_at = ?
    WHERE id = ?
  `).run(nowIso(), stackId);
}

export function recordRuntimeStackService(
  db: Database,
  stackId: string,
  serviceRef: string,
  nowIso: () => string,
): void {
  db.query(`
    UPDATE runtime_stacks
    SET service_ref = ?, updated_at = ?
    WHERE id = ?
  `).run(serviceRef, nowIso(), stackId);
}

export function recordRuntimeStackVolume(
  db: Database,
  stackId: string,
  volumeRef: string,
  nowIso: () => string,
): void {
  db.query(`
    UPDATE runtime_stacks
    SET workspace_volume_ref = ?, updated_at = ?
    WHERE id = ?
  `).run(volumeRef, nowIso(), stackId);
}

export function markRuntimeStackActive(
  db: Database,
  stackId: string,
  gatewayUrl: string,
  healthStatus: string,
  nowIso: () => string,
): void {
  db.query(`
    UPDATE runtime_stacks
    SET status = 'active',
        gateway_url = ?,
        last_health_status = ?,
        last_error = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(gatewayUrl, healthStatus, nowIso(), stackId);
}

export function markRuntimeStackFailed(
  db: Database,
  stackId: string,
  error: string,
  nowIso: () => string,
): void {
  db.query(`
    UPDATE runtime_stacks
    SET status = 'failed', last_error = ?, updated_at = ?
    WHERE id = ?
  `).run(error.slice(0, 2_000), nowIso(), stackId);
}

export function assistantApiStatusForRuntimeStack(
  stack: RuntimeStackRow | null,
): "initializing" | "active" | "to_be_deleted" {
  if (stack?.status === "active" && stack.gateway_url) return "active";
  if (stack?.status === "deleted") return "to_be_deleted";
  return "initializing";
}

export function operationalStateForRuntimeStack(
  stack: RuntimeStackRow | null,
):
  | "provisioning"
  | "active"
  | "maintenance_mode"
  | "crash_loop"
  | "not_found"
  | "unreachable" {
  switch (stack?.status) {
    case "active":
      return stack.gateway_url ? "active" : "unreachable";
    case "suspended":
      return "maintenance_mode";
    case "failed":
      return "crash_loop";
    case "deleted":
      return "not_found";
    case "provisioning":
    case undefined:
      return "provisioning";
  }
}

export function isRuntimeStackRoutable(
  stack: RuntimeStackRow | null,
): stack is RuntimeStackRow & { gateway_url: string } {
  return stack?.status === "active" && !!stack.gateway_url;
}

export function runtimeNotReadyPayload(stack: RuntimeStackRow | null) {
  return {
    detail: "Assistant runtime is not ready.",
    code: "runtime_not_ready",
    runtime_status: stack?.status ?? "missing",
    runtime_stack_id: stack?.id ?? null,
  };
}
