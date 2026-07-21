import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Database } from "bun:sqlite";

import {
  validatePooledModelProviderKey,
  type PooledModelKeyValidationResult,
} from "./pooled-model-key-validation.js";
import {
  resolveActiveRuntimeWorkerLeaseServiceBinding,
  type RuntimeWorkerLeaseServiceBinding,
} from "./runtime-worker-service-tokens.js";
import {
  isRuntimeWorkerBootstrapInferenceProvider,
  RUNTIME_WORKER_BOOTSTRAP_INFERENCE_PROVIDERS,
  type RuntimeWorkerBootstrapInferenceProvider,
} from "./runtime-worker-production-transport.js";

type EnvLike = Record<string, string | undefined>;

const ENABLE_ENV = "WORKLIN_POOLED_MODEL_KEY_VAULT_ENABLED";
const MASTER_SECRET_ENV = [
  "WORKLIN_POOLED_MODEL_KEY_VAULT",
  "MASTER",
  "KEY",
].join("_");
/**
 * Pooled message requests have a six-minute hard deadline. Give the private
 * capability one additional minute for final response/drain work, while
 * keeping it unusable as soon as its request handle is revoked. The live
 * worker lease and generation are revalidated from the database on every
 * lookup, so this ceiling must not be shortened to the lease timestamp that
 * was current when the request began.
 */
export const POOLED_MODEL_KEY_CAPABILITY_TTL_SECONDS = 7 * 60;
const CAPABILITY_HEADER = Object.freeze({
  alg: "HS256",
  kid: "pooled-model-key-v1",
  typ: "JWT",
});
const CAPABILITY_HEADER_ENCODED = Buffer.from(
  JSON.stringify(CAPABILITY_HEADER),
).toString("base64url");
const CAPABILITY_KEY_CONTEXT =
  "worklin/pooled-model-key-vault/request-capability/v1";
const ENCRYPTION_AAD_CONTEXT = "worklin/pooled-model-key-vault/ciphertext/v1";
const MASTER_KEY_VERIFIER_CONTEXT =
  "worklin/pooled-model-key-vault/master-key-verifier/v1";
const MAX_CAPABILITY_LENGTH = 8_192;
const MAX_KEY_LENGTH = 65_536;

export const POOLED_MODEL_KEY_CAPABILITY_HEADER =
  "x-worklin-pooled-model-key-capability";
export const POOLED_MODEL_KEY_RESOLVE_PATH =
  "/internal/v1/runtime-workers/model-provider-key";

export const POOLED_MODEL_KEY_PROVIDERS = Object.freeze([
  "anthropic",
  "fireworks",
  "gemini",
  "kimi",
  "minimax",
  "openai",
  "openai-compatible",
  "openrouter",
] as const);

const PROVIDER_SET = new Set<string>(POOLED_MODEL_KEY_PROVIDERS);

export type PooledModelKeyProvider =
  (typeof POOLED_MODEL_KEY_PROVIDERS)[number];

export interface PooledModelKeyTenant {
  organizationId: string;
  userId: string;
  assistantId: string;
}

export type PooledModelKeyVaultConfig =
  | { enabled: false }
  | { enabled: true; masterKey: Buffer };

interface PooledModelKeyRow {
  nonce: string;
  ciphertext: string;
  auth_tag: string;
}

interface PooledModelKeyVerificationRow extends PooledModelKeyRow {
  organization_id: string;
  user_id: string;
  assistant_id: string;
  account: string;
}

interface CapabilityClaims {
  version: 1;
  iss: "worklin-control-plane";
  aud: "worklin-pooled-model-key-vault";
  iat: number;
  exp: number;
  jti: string;
  organization_id: string;
  user_id: string;
  assistant_id: string;
  worker_stack_id: string;
  lease_generation: number;
}

export type PooledModelKeyCapabilityResult =
  | {
      ok: true;
      tenant: PooledModelKeyTenant;
      provider: PooledModelKeyProvider;
      value: string | null;
    }
  | {
      ok: false;
      reason:
        | "disabled"
        | "malformed_capability"
        | "invalid_capability"
        | "expired_capability"
        | "invalid_provider"
        | "inactive_request"
        | "inactive_lease"
        | "stale_lease_generation"
        | "lease_binding_mismatch";
    };

export interface PooledSecretRouteInput {
  method: string;
  routeSegments: readonly string[];
  tenant: PooledModelKeyTenant;
  body?: unknown;
}

export interface PooledSecretRouteResponse {
  status: number;
  body: unknown;
}

export type PooledModelKeyValidator = (
  provider: RuntimeWorkerBootstrapInferenceProvider,
  value: string,
) => Promise<PooledModelKeyValidationResult>;

function strictBooleanEnv(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (value !== value.trim()) {
    throw new Error(`${name} must not contain surrounding whitespace.`);
  }
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean.`);
}

export function pooledModelKeyVaultConfigFromEnv(
  rawEnv: EnvLike,
): PooledModelKeyVaultConfig {
  if (!strictBooleanEnv(ENABLE_ENV, rawEnv[ENABLE_ENV])) {
    return Object.freeze({ enabled: false });
  }
  const encoded = rawEnv[MASTER_SECRET_ENV] ?? "";
  if (encoded !== encoded.trim() || !/^[0-9a-f]{64}$/iu.test(encoded)) {
    throw new Error(
      `${MASTER_SECRET_ENV} must be exactly 64 hexadecimal characters.`,
    );
  }
  return Object.freeze({
    enabled: true,
    masterKey: Buffer.from(encoded, "hex"),
  });
}

export function ensurePooledModelKeyVaultSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pooled_model_provider_keys (
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      account TEXT NOT NULL,
      nonce TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, user_id, assistant_id, account)
    );
    CREATE INDEX IF NOT EXISTS idx_pooled_model_provider_keys_tenant
      ON pooled_model_provider_keys (organization_id, user_id, assistant_id);
    CREATE TABLE IF NOT EXISTS pooled_model_key_vault_meta (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      key_verifier TEXT NOT NULL
    );
  `);
}

export function requirePooledModelKeyVaultForPoolStartup(
  db: Database,
  rawEnv: EnvLike,
): PooledModelKeyVaultConfig & { enabled: true } {
  const config = pooledModelKeyVaultConfigFromEnv(rawEnv);
  if (!config.enabled) {
    throw new Error(
      "Pooled runtime startup requires WORKLIN_POOLED_MODEL_KEY_VAULT_ENABLED=true.",
    );
  }
  ensurePooledModelKeyVaultSchema(db);
  verifyPooledModelKeyVaultMasterKey(db, config.masterKey);
  return config;
}

function assertOpaqueId(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`Pooled model key ${label} is invalid.`);
  }
  return value;
}

function normalizeTenant(tenant: PooledModelKeyTenant): PooledModelKeyTenant {
  return Object.freeze({
    organizationId: assertOpaqueId(tenant.organizationId, "organization"),
    userId: assertOpaqueId(tenant.userId, "user"),
    assistantId: assertOpaqueId(tenant.assistantId, "assistant"),
  });
}

export function canonicalPooledModelKeyProvider(
  value: unknown,
): PooledModelKeyProvider | null {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !PROVIDER_SET.has(value)
  ) {
    return null;
  }
  return value as PooledModelKeyProvider;
}

export function canonicalPooledModelKeyAccount(
  provider: PooledModelKeyProvider,
): string {
  return `credential/${provider}/api_key`;
}

function encryptionAad(tenant: PooledModelKeyTenant, account: string): Buffer {
  return Buffer.from(
    `${ENCRYPTION_AAD_CONTEXT}\u0000${JSON.stringify([
      tenant.organizationId,
      tenant.userId,
      tenant.assistantId,
      account,
    ])}`,
    "utf8",
  );
}

function deriveCapabilityKey(masterKey: Buffer): Buffer {
  return createHmac("sha256", masterKey)
    .update(CAPABILITY_KEY_CONTEXT)
    .digest();
}

function masterKeyVerifier(masterKey: Buffer): string {
  return createHmac("sha256", masterKey)
    .update(MASTER_KEY_VERIFIER_CONTEXT)
    .digest("hex");
}

function decryptStoredValue(
  masterKey: Buffer,
  tenant: PooledModelKeyTenant,
  account: string,
  row: PooledModelKeyRow,
): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    masterKey,
    Buffer.from(row.nonce, "base64"),
  );
  decipher.setAAD(encryptionAad(tenant, account));
  decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function verifyPooledModelKeyVaultMasterKey(
  db: Database,
  masterKey: Buffer,
): void {
  const expected = masterKeyVerifier(masterKey);
  const existing =
    db
      .query<{ key_verifier: string }, []>(
        `SELECT key_verifier
           FROM pooled_model_key_vault_meta
          WHERE singleton = 1`,
      )
      .get() ?? null;
  if (existing) {
    const encoded = existing.key_verifier;
    if (!/^[0-9a-f]{64}$/u.test(encoded)) {
      throw new Error("Pooled model key vault master-key verifier is invalid.");
    }
    const left = Buffer.from(encoded, "hex");
    const right = Buffer.from(expected, "hex");
    if (!timingSafeEqual(left, right)) {
      throw new Error(
        "Pooled model key vault master key does not match persisted ciphertext.",
      );
    }
    return;
  }

  const existingRows = db
    .query<PooledModelKeyVerificationRow, []>(
      `SELECT
         organization_id, user_id, assistant_id, account,
         nonce, ciphertext, auth_tag
       FROM pooled_model_provider_keys`,
    )
    .all();
  try {
    for (const row of existingRows) {
      decryptStoredValue(
        masterKey,
        {
          organizationId: row.organization_id,
          userId: row.user_id,
          assistantId: row.assistant_id,
        },
        row.account,
        row,
      );
    }
  } catch {
    throw new Error(
      "Pooled model key vault master key does not match persisted ciphertext.",
    );
  }
  db.query(
    `INSERT INTO pooled_model_key_vault_meta (singleton, key_verifier)
     VALUES (1, ?)`,
  ).run(expected);
}

function safeJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseCapabilityClaims(value: string): CapabilityClaims | null {
  const record = safeJsonRecord(value);
  if (
    !record ||
    record.version !== 1 ||
    record.iss !== "worklin-control-plane" ||
    record.aud !== "worklin-pooled-model-key-vault" ||
    !Number.isSafeInteger(record.iat) ||
    !Number.isSafeInteger(record.exp) ||
    typeof record.jti !== "string" ||
    typeof record.organization_id !== "string" ||
    typeof record.user_id !== "string" ||
    typeof record.assistant_id !== "string" ||
    typeof record.worker_stack_id !== "string" ||
    !Number.isSafeInteger(record.lease_generation)
  ) {
    return null;
  }
  try {
    return {
      version: 1,
      iss: "worklin-control-plane",
      aud: "worklin-pooled-model-key-vault",
      iat: record.iat as number,
      exp: record.exp as number,
      jti: assertOpaqueId(record.jti, "request"),
      organization_id: assertOpaqueId(record.organization_id, "organization"),
      user_id: assertOpaqueId(record.user_id, "user"),
      assistant_id: assertOpaqueId(record.assistant_id, "assistant"),
      worker_stack_id: assertOpaqueId(record.worker_stack_id, "worker stack"),
      lease_generation: record.lease_generation as number,
    };
  } catch {
    return null;
  }
}

export class PooledModelKeyVault {
  private readonly capabilityKey: Buffer | null;
  private readonly activeRequests = new Map<
    string,
    {
      tenant: PooledModelKeyTenant;
      workerStackId: string;
      leaseGeneration: number;
      expiresAtSeconds: number;
    }
  >();

  constructor(
    private readonly db: Database,
    private readonly config: PooledModelKeyVaultConfig,
    private readonly validateProviderKey: PooledModelKeyValidator =
      validatePooledModelProviderKey,
  ) {
    this.capabilityKey = config.enabled
      ? deriveCapabilityKey(config.masterKey)
      : null;
    if (config.enabled) {
      ensurePooledModelKeyVaultSchema(db);
      verifyPooledModelKeyVaultMasterKey(db, config.masterKey);
    }
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  set(
    tenantInput: PooledModelKeyTenant,
    providerInput: unknown,
    value: string,
    nowIso: string,
  ): PooledModelKeyProvider {
    const tenant = normalizeTenant(tenantInput);
    const provider = canonicalPooledModelKeyProvider(providerInput);
    if (!this.config.enabled)
      throw new Error("Pooled model key vault is disabled.");
    if (!provider) throw new Error("Pooled model key provider is invalid.");
    if (!isRuntimeWorkerBootstrapInferenceProvider(provider)) {
      throw new Error(
        "Pooled model provider requires configuration that is available only on a dedicated runtime.",
      );
    }
    const otherProviders = this.list(tenant).filter(
      (configured) => configured !== provider,
    );
    if (otherProviders.length > 0) {
      throw new Error(
        "Pooled runtimes support exactly one configured model provider per tenant.",
      );
    }
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > MAX_KEY_LENGTH
    ) {
      throw new Error("Pooled model provider key is invalid.");
    }
    if (!Number.isFinite(Date.parse(nowIso))) {
      throw new Error("Pooled model key timestamp is invalid.");
    }

    const account = canonicalPooledModelKeyAccount(provider);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.config.masterKey, nonce);
    cipher.setAAD(encryptionAad(tenant, account));
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    this.db
      .query(
        `INSERT INTO pooled_model_provider_keys (
           organization_id, user_id, assistant_id, account,
           nonce, ciphertext, auth_tag, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (organization_id, user_id, assistant_id, account)
         DO UPDATE SET
           nonce = excluded.nonce,
           ciphertext = excluded.ciphertext,
           auth_tag = excluded.auth_tag,
           updated_at = excluded.updated_at`,
      )
      .run(
        tenant.organizationId,
        tenant.userId,
        tenant.assistantId,
        account,
        nonce.toString("base64"),
        ciphertext.toString("base64"),
        authTag.toString("base64"),
        nowIso,
        nowIso,
      );
    return provider;
  }

  get(
    tenantInput: PooledModelKeyTenant,
    providerInput: unknown,
  ): string | null {
    const tenant = normalizeTenant(tenantInput);
    const provider = canonicalPooledModelKeyProvider(providerInput);
    if (!this.config.enabled)
      throw new Error("Pooled model key vault is disabled.");
    if (!provider) throw new Error("Pooled model key provider is invalid.");
    const account = canonicalPooledModelKeyAccount(provider);
    const row =
      this.db
        .query<PooledModelKeyRow, [string, string, string, string]>(
          `SELECT nonce, ciphertext, auth_tag
             FROM pooled_model_provider_keys
            WHERE organization_id = ?
              AND user_id = ?
              AND assistant_id = ?
              AND account = ?`,
        )
        .get(
          tenant.organizationId,
          tenant.userId,
          tenant.assistantId,
          account,
        ) ?? null;
    if (!row) return null;

    try {
      return decryptStoredValue(this.config.masterKey, tenant, account, row);
    } catch {
      throw new Error("Pooled model provider key could not be decrypted.");
    }
  }

  list(tenantInput: PooledModelKeyTenant): PooledModelKeyProvider[] {
    const tenant = normalizeTenant(tenantInput);
    if (!this.config.enabled)
      throw new Error("Pooled model key vault is disabled.");
    const rows = this.db
      .query<{ account: string }, [string, string, string]>(
        `SELECT account
           FROM pooled_model_provider_keys
          WHERE organization_id = ?
            AND user_id = ?
            AND assistant_id = ?
          ORDER BY account ASC`,
      )
      .all(tenant.organizationId, tenant.userId, tenant.assistantId);
    return rows.flatMap(({ account }) => {
      const match = /^credential\/([^/]+)\/api_key$/u.exec(account);
      const provider = canonicalPooledModelKeyProvider(match?.[1]);
      return provider ? [provider] : [];
    });
  }

  delete(tenantInput: PooledModelKeyTenant, providerInput: unknown): boolean {
    const tenant = normalizeTenant(tenantInput);
    const provider = canonicalPooledModelKeyProvider(providerInput);
    if (!this.config.enabled)
      throw new Error("Pooled model key vault is disabled.");
    if (!provider) throw new Error("Pooled model key provider is invalid.");
    const result = this.db
      .query(
        `DELETE FROM pooled_model_provider_keys
          WHERE organization_id = ?
            AND user_id = ?
            AND assistant_id = ?
            AND account = ?`,
      )
      .run(
        tenant.organizationId,
        tenant.userId,
        tenant.assistantId,
        canonicalPooledModelKeyAccount(provider),
      );
    return result.changes === 1;
  }

  mintRequestCapability(
    tenantInput: PooledModelKeyTenant,
    binding: RuntimeWorkerLeaseServiceBinding,
    requestId: string,
    nowMs: number,
  ): string {
    const tenant = normalizeTenant(tenantInput);
    if (!this.config.enabled || !this.capabilityKey) {
      throw new Error("Pooled model key vault is disabled.");
    }
    if (
      binding.organizationId !== tenant.organizationId ||
      binding.userId !== tenant.userId ||
      binding.assistantId !== tenant.assistantId
    ) {
      throw new Error("Pooled model key capability binding is invalid.");
    }
    assertOpaqueId(binding.workerStackId, "worker stack");
    assertOpaqueId(requestId, "request");
    if (
      !Number.isSafeInteger(binding.leaseGeneration) ||
      binding.leaseGeneration < 1 ||
      !Number.isSafeInteger(binding.leaseExpiresAtMs) ||
      !Number.isSafeInteger(nowMs) ||
      nowMs < 0 ||
      binding.leaseExpiresAtMs <= nowMs
    ) {
      throw new Error("Pooled model key capability lease is invalid.");
    }
    const nowSeconds = Math.floor(nowMs / 1_000);
    const expiresAtSeconds =
      nowSeconds + POOLED_MODEL_KEY_CAPABILITY_TTL_SECONDS;
    if (expiresAtSeconds <= nowSeconds) {
      throw new Error("Pooled model key capability lease expires too soon.");
    }
    const claims: CapabilityClaims = {
      version: 1,
      iss: "worklin-control-plane",
      aud: "worklin-pooled-model-key-vault",
      iat: nowSeconds,
      exp: expiresAtSeconds,
      jti: requestId,
      organization_id: tenant.organizationId,
      user_id: tenant.userId,
      assistant_id: tenant.assistantId,
      worker_stack_id: binding.workerStackId,
      lease_generation: binding.leaseGeneration,
    };
    this.pruneExpiredRequests(nowSeconds);
    if (this.activeRequests.has(claims.jti)) {
      throw new Error("Pooled model key request capability is already active.");
    }
    this.activeRequests.set(claims.jti, {
      tenant,
      workerStackId: claims.worker_stack_id,
      leaseGeneration: claims.lease_generation,
      expiresAtSeconds: claims.exp,
    });
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signingInput = `${CAPABILITY_HEADER_ENCODED}.${payload}`;
    const signature = createHmac("sha256", this.capabilityKey)
      .update(signingInput)
      .digest("base64url");
    return `${signingInput}.${signature}`;
  }

  resolveWithCapability(
    capability: string,
    providerInput: unknown,
    nowMs: number,
  ): PooledModelKeyCapabilityResult {
    if (!this.config.enabled || !this.capabilityKey) {
      return { ok: false, reason: "disabled" };
    }
    const provider = canonicalPooledModelKeyProvider(providerInput);
    if (!provider) return { ok: false, reason: "invalid_provider" };
    if (
      typeof capability !== "string" ||
      capability.length < 1 ||
      capability.length > MAX_CAPABILITY_LENGTH ||
      !Number.isSafeInteger(nowMs) ||
      nowMs < 0
    ) {
      return { ok: false, reason: "malformed_capability" };
    }
    const parts = capability.split(".");
    if (
      parts.length !== 3 ||
      parts[0] !== CAPABILITY_HEADER_ENCODED ||
      !parts[1] ||
      !parts[2]
    ) {
      return { ok: false, reason: "malformed_capability" };
    }
    const signingInput = `${parts[0]}.${parts[1]}`;
    const expected = createHmac("sha256", this.capabilityKey)
      .update(signingInput)
      .digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(parts[2], "base64url");
    } catch {
      return { ok: false, reason: "malformed_capability" };
    }
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      return { ok: false, reason: "invalid_capability" };
    }
    let claims: CapabilityClaims | null = null;
    try {
      claims = parseCapabilityClaims(
        Buffer.from(parts[1], "base64url").toString("utf8"),
      );
    } catch {
      return { ok: false, reason: "malformed_capability" };
    }
    if (!claims) return { ok: false, reason: "malformed_capability" };
    const nowSeconds = Math.floor(nowMs / 1_000);
    this.pruneExpiredRequests(nowSeconds);
    if (
      claims.exp <= nowSeconds ||
      claims.iat > nowSeconds + 5 ||
      claims.exp - claims.iat > POOLED_MODEL_KEY_CAPABILITY_TTL_SECONDS
    ) {
      return { ok: false, reason: "expired_capability" };
    }
    const activeRequest = this.activeRequests.get(claims.jti);
    if (
      !activeRequest ||
      activeRequest.expiresAtSeconds !== claims.exp ||
      activeRequest.workerStackId !== claims.worker_stack_id ||
      activeRequest.leaseGeneration !== claims.lease_generation ||
      activeRequest.tenant.organizationId !== claims.organization_id ||
      activeRequest.tenant.userId !== claims.user_id ||
      activeRequest.tenant.assistantId !== claims.assistant_id
    ) {
      return { ok: false, reason: "inactive_request" };
    }

    const active = resolveActiveRuntimeWorkerLeaseServiceBinding(
      this.db,
      claims.worker_stack_id,
      nowMs,
    );
    if (!active) return { ok: false, reason: "inactive_lease" };
    if (active.leaseGeneration !== claims.lease_generation) {
      return { ok: false, reason: "stale_lease_generation" };
    }
    if (
      active.organizationId !== claims.organization_id ||
      active.userId !== claims.user_id ||
      active.assistantId !== claims.assistant_id
    ) {
      return { ok: false, reason: "lease_binding_mismatch" };
    }
    const tenant = {
      organizationId: claims.organization_id,
      userId: claims.user_id,
      assistantId: claims.assistant_id,
    };
    return {
      ok: true,
      tenant,
      provider,
      value: this.get(tenant, provider),
    };
  }

  revokeRequestCapability(requestId: string): boolean {
    return this.activeRequests.delete(assertOpaqueId(requestId, "request"));
  }

  revokeAllRequestCapabilities(): number {
    const revoked = this.activeRequests.size;
    this.activeRequests.clear();
    return revoked;
  }

  private pruneExpiredRequests(nowSeconds: number): void {
    for (const [requestId, request] of this.activeRequests) {
      if (request.expiresAtSeconds <= nowSeconds) {
        this.activeRequests.delete(requestId);
      }
    }
  }

  async handleSecretRoute(
    input: PooledSecretRouteInput,
  ): Promise<PooledSecretRouteResponse> {
    const providerError = (name: unknown): PooledSecretRouteResponse => ({
      status: 400,
      body: {
        detail: `Unknown API key provider: ${String(name)}. Valid providers: ${POOLED_MODEL_KEY_PROVIDERS.join(", ")}`,
      },
    });
    const body =
      input.body && typeof input.body === "object" && !Array.isArray(input.body)
        ? (input.body as Record<string, unknown>)
        : null;
    const isRead =
      input.routeSegments.length === 2 &&
      input.routeSegments[0] === "secrets" &&
      input.routeSegments[1] === "read";
    const isRoot =
      input.routeSegments.length === 1 && input.routeSegments[0] === "secrets";
    if ((!isRoot && !isRead) || (isRead && input.method !== "POST")) {
      return { status: 404, body: { detail: "Not found." } };
    }
    if (isRoot && input.method === "GET") {
      const secrets = this.list(input.tenant).map((name) => ({
        type: "api_key" as const,
        name,
      }));
      return { status: 200, body: { secrets, accounts: secrets } };
    }
    if (!body) {
      return { status: 400, body: { detail: "Request body is required" } };
    }
    if (body.type !== "api_key") {
      return {
        status: 409,
        body: {
          detail:
            "Pooled runtimes support model-provider API keys only. This credential requires a dedicated assistant runtime.",
          code: "pooled_runtime_credential_operations_require_dedicated_runtime",
        },
      };
    }
    const provider = canonicalPooledModelKeyProvider(body.name);
    if (!provider) return providerError(body.name);

    if (isRoot && input.method === "POST") {
      if (typeof body.value !== "string" || body.value.length < 1) {
        return { status: 400, body: { detail: "value is required" } };
      }
      if (!isRuntimeWorkerBootstrapInferenceProvider(provider)) {
        return {
          status: 409,
          body: {
            detail:
              `${provider} requires provider URL and model metadata that the pooled API-key setup cannot store. ` +
              `Choose one of: ${RUNTIME_WORKER_BOOTSTRAP_INFERENCE_PROVIDERS.join(", ")}, or use a dedicated assistant runtime.`,
            code: "pooled_runtime_model_provider_requires_dedicated_runtime",
          },
        };
      }
      const existingProviders = this.list(input.tenant).filter(
        (configured) => configured !== provider,
      );
      if (existingProviders.length > 0) {
        return {
          status: 409,
          body: {
            detail: `Pooled runtimes use exactly one model provider. Remove ${existingProviders.join(", ")} before adding ${provider}.`,
            code: "pooled_runtime_single_model_provider_required",
          },
        };
      }
      let validation: PooledModelKeyValidationResult;
      try {
        validation = await this.validateProviderKey(provider, body.value);
      } catch {
        validation = {
          valid: false,
          reason:
            "The provider could not verify this connection. Check your network and try again.",
        };
      }
      if (!validation.valid) {
        return {
          status: 400,
          body: {
            detail: `${provider} API key was not saved. ${validation.reason}`,
          },
        };
      }
      this.set(input.tenant, provider, body.value, new Date().toISOString());
      return {
        status: 200,
        body: { success: true, type: "api_key", name: provider },
      };
    }
    if (isRoot && input.method === "DELETE") {
      if (!this.delete(input.tenant, provider)) {
        return {
          status: 404,
          body: { detail: `API key not found: ${provider}` },
        };
      }
      return {
        status: 200,
        body: { success: true, type: "api_key", name: provider },
      };
    }
    if (isRead) {
      if (body.reveal !== undefined && typeof body.reveal !== "boolean") {
        return { status: 400, body: { detail: "reveal must be a boolean" } };
      }
      const value = this.get(input.tenant, provider);
      if (value === null) {
        return {
          status: 200,
          body: { found: false, unreachable: false },
        };
      }
      return {
        status: 200,
        body: {
          found: true,
          masked: maskSecret(value),
          unreachable: false,
          ...(body.reveal === true ? { revealSupported: false } : {}),
        },
      };
    }
    return { status: 405, body: { detail: "Method not allowed." } };
  }
}

function maskSecret(value: string): string {
  const minHidden = 3;
  const maxVisible = Math.max(1, value.length - minHidden);
  const prefixLen = Math.min(10, maxVisible);
  const suffixLen = Math.min(4, Math.max(0, maxVisible - prefixLen));
  return `${value.slice(0, prefixLen)}...${suffixLen > 0 ? value.slice(-suffixLen) : ""}`;
}
