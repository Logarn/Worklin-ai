import { Database } from "bun:sqlite";
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { auth } from "express-openid-connect";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  assistantApiStatusForRuntimeStack,
  claimPreprovisionedRuntimeStack,
  countAllocatedRuntimeServicesForOrganization,
  claimRuntimeServiceProvisioningLease,
  deriveRuntimeActorSigningKey,
  ensureRuntimeStackForAssistant,
  ensureRuntimeStackSchema,
  getRuntimeStackById,
  isRuntimeStackRoutable,
  markRuntimeStackActive,
  markRuntimeStackFailed,
  markRuntimeStackProvisioning,
  operationalStateForRuntimeStack,
  prepareRuntimeStackActorSigningScope,
  recordRuntimeServiceCreateAttempt,
  recordRuntimeStackService,
  recordRuntimeStackVolume,
  recordRuntimeVolumeCreateAttempt,
  releaseRuntimeServiceProvisioningLease,
  renewRuntimeServiceProvisioningLease,
  runtimeNotReadyPayload,
  runtimeStackConfigFromEnv,
  type RuntimeStackRow,
} from "./runtime-stacks.js";
import { managedVoiceRoutingHintFromToken } from "./live-voice-provider-callback.js";
import {
  ensureAssistantStoreSchema,
  getAssistantAdminAccessConsent,
  getOrCreateAssistant as getOrCreateStoredAssistant,
  getOrCreateOrganization as getOrCreateStoredOrganization,
  hasAcceptedAssistantConsent,
  setAssistantAdminAccessConsent,
  type AssistantRow,
  type OrganizationRow,
} from "./assistant-store.js";
import {
  BoundedKeyedTaskScheduler,
  provisionRailwayRuntime,
  railwayRuntimeWorkspaceCapacityError,
  railwayProvisionerConfigurationError,
  railwayProvisionerConfigFromEnv,
} from "./railway-runtime-provisioner.js";
import { ensureArtifactSharingSchema } from "./artifact-sharing-store.js";
import {
  acceptArtifactInvitation,
  createArtifactInvitation,
  getActiveArtifactGrantForRecipient,
  getActiveInvitationByTokenHash,
  isCollaborationRole,
  listActiveArtifactGrantsForRecipient,
  normalizeInviteEmail,
} from "./artifact-sharing-store.js";
import { pathEquals, pathIsOrStartsWith } from "./http-paths.js";
import {
  brandResearchRunPayload,
  createOrGetBrandResearchRun,
  ensureBrandResearchRunSchema,
  getBrandResearchRunForUser,
  listBrandResearchRunsForUser,
  markBrandResearchRunCancelled,
} from "./brand-research-runs.js";
import {
  acceptWorkspaceInvitationForUser,
  assignAssistant,
  canManageAssignments,
  canManageMembers,
  createWorkspaceInvitation,
  deactivateWorkspaceMember,
  ensureWorkspaceManagementSchema,
  getWorkspaceOrganizationContext,
  listAccessibleAssistantIds,
  listAssistantAssignments,
  listPendingWorkspaceInvitations,
  listWorkspaceMembers,
  listWorkspaceOrganizationsForUser,
  revokeWorkspaceInvitation,
  setWorkspaceMemberRole,
  unassignAssistant,
} from "./workspace-management-store.js";
import {
  getOrganizationMembership,
  getOrCreateOrganizationMembership,
  type OrganizationMembershipRow,
  type OrganizationRole,
} from "./organization-membership-store.js";
import {
  deleteWorkspaceResearchProviderCredential,
  isWorkspaceResearchProviderId,
  listWorkspaceResearchProviders,
  saveWorkspaceResearchProviderCredential,
} from "./workspace-research-providers.js";
import {
  applyRuntimeTenantHeaders,
  createRuntimeTenantContext,
  RuntimeTenantContextError,
  runtimeTenantContextClaim,
  type RuntimeTenantContext,
} from "./runtime-tenant-context.js";
import {
  acquireTenantRuntimeAdmission,
  classifyTenantRuntimeRequest,
  ensureTenantRuntimeAdmissionSchema,
  releaseTenantRuntimeAdmission,
  renewTenantRuntimeAdmission,
  tenantRuntimeAdmissionConfigFromEnv,
  type TenantRuntimeAdmissionResult,
} from "./tenant-runtime-admission.js";
import {
  ensureTenantRuntimeOperationsSchema,
  guardTenantStorageOperation,
  persistRuntimeCapacityAlert,
  recordTrustedTenantStorageObservation,
  recordTenantRuntimeUsage,
  tenantRuntimeOperationsConfigFromEnv,
  type TenantStorageGuardResult,
  type TenantRuntimeUsageMetric,
} from "./tenant-runtime-operations.js";
import {
  getRuntimeWorkerCapacityTelemetry,
  runtimeWorkerPoolConfigFromEnv,
} from "./runtime-worker-dispatcher.js";
import { createRuntimeWorkerProductionCoordinatorFromEnv } from "./runtime-worker-production-coordinator.js";
import { isRuntimeWorkerBootstrapInferenceProvider } from "./runtime-worker-production-transport.js";
import {
  classifyRuntimeWorkerProxyRoute,
  type RuntimeWorkerProxyRouteDecision,
} from "./runtime-worker-proxy-route-policy.js";
import { selectRuntimeWorkerRoutingPolicy } from "./runtime-worker-routing-policy.js";
import {
  parseManagedPooledVoiceSessionBootstrap,
  RuntimeWorkerSessionLeaseRegistry,
} from "./runtime-worker-session-leases.js";
import type { RuntimeWorkerLeaseServiceBinding } from "./runtime-worker-service-tokens.js";
import { activatePooledRuntimeWorkersAtStartup } from "./runtime-worker-startup-gate.js";
import {
  POOLED_MODEL_KEY_CAPABILITY_HEADER,
  POOLED_MODEL_KEY_RESOLVE_PATH,
  PooledModelKeyVault,
  pooledModelKeyVaultConfigFromEnv,
} from "./pooled-model-key-vault.js";
import {
  createRuntimeProxyAbortLifecycle,
  pipeRuntimeResponseBody,
} from "./runtime-response-stream.js";
import {
  authorizeRuntimeWorkerOperatorRecovery,
  parseRuntimeWorkerOperatorRecoveryRequest,
  runtimeWorkerOperatorRecoveryConfigFromEnv,
  RUNTIME_WORKER_OPERATOR_RECOVERY_PATH,
} from "./runtime-worker-operator-recovery.js";
import {
  acquireRuntimeWorkerCoordinatorOwnership,
  runtimeWorkerCoordinatorOwnershipConfigFromEnv,
  RuntimeWorkerCoordinatorOwnershipGuard,
  RuntimeWorkerCoordinatorRequestAbortRegistry,
} from "./runtime-worker-coordinator-ownership.js";

const SESSION_COOKIE = "worklin_session";
const SECURE_CSRF_COOKIE = "__Secure-csrftoken";
const LOCAL_CSRF_COOKIE = "csrftoken";
const AUTH0_SESSION_COOKIE = "worklin_auth0_session";
const CANONICAL_VERCEL_WEB_ORIGIN = "https://worklin-ai.vercel.app";
const LEGACY_VERCEL_WEB_ORIGIN = "https://ai-retention-marketer.vercel.app";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const ACTOR_TOKEN_TTL_SECONDS = 5 * 60;
const POLICY_EPOCH = 1;
const TENANT_MUTATION_RESERVATION_FLOOR_BYTES = 4 * 1024 * 1024;

function runtimeWorkerSessionTimer() {
  return {
    schedule(callback: () => Promise<void>, delayMs: number) {
      const handle = setTimeout(() => {
        void callback().catch(() => {
          console.error("pooled_runtime_held_session_timer_failed");
        });
      }, delayMs);
      handle.unref?.();
      return handle;
    },
    cancel(handle: unknown) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}
const RELEASE_SHA =
  process.env.WORKLIN_RELEASE_SHA ??
  process.env.RAILWAY_GIT_COMMIT_SHA ??
  process.env.GITHUB_SHA ??
  "unknown";

function canonicalHostedWebOrigin(origin: string): string | null {
  if (
    origin === CANONICAL_VERCEL_WEB_ORIGIN ||
    origin === LEGACY_VERCEL_WEB_ORIGIN
  ) {
    return CANONICAL_VERCEL_WEB_ORIGIN;
  }
  return null;
}

function resolvePublicAuthBaseUrl(
  webOrigin: string,
  fallbackApiOrigin: string,
): string {
  const canonicalHosted = canonicalHostedWebOrigin(webOrigin);
  if (canonicalHosted) return canonicalHosted;
  try {
    const parsed = new URL(webOrigin);
    if (
      parsed.protocol === "https:" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "127.0.0.1"
    ) {
      return trimTrailingSlash(parsed.toString());
    }
  } catch {
    // Fall back to the API origin below.
  }
  return fallbackApiOrigin;
}

const configuredWebOrigin = trimTrailingSlash(
  process.env.WORKLIN_WEB_ORIGIN ?? CANONICAL_VERCEL_WEB_ORIGIN,
);
const configuredAuth0BaseUrl = trimTrailingSlash(
  process.env.AUTH0_BASE_URL ??
    process.env.BASE_URL ??
    process.env.WORKLIN_API_ORIGIN ??
    "https://api.worklin.ai",
);
const hostedWebBaseUrl = resolvePublicAuthBaseUrl(
  configuredWebOrigin,
  configuredAuth0BaseUrl,
);
const auth0ClientCredential =
  process.env.AUTH0_CLIENT_SECRET ?? process.env.CLIENT_SECRET ?? "";

const env = {
  port: Number(
    process.env.WORKLIN_CONTROL_PLANE_PORT ?? process.env.PORT ?? 8080,
  ),
  host: process.env.WORKLIN_CONTROL_PLANE_HOST ?? "0.0.0.0",
  webOrigin: configuredWebOrigin,
  apiOrigin: trimTrailingSlash(
    process.env.WORKLIN_API_ORIGIN ?? "https://api.worklin.ai",
  ),
  gatewayUrl: trimTrailingSlash(
    process.env.WORKLIN_GATEWAY_URL ?? "http://gateway:7830",
  ),
  runtimeMode: process.env.WORKLIN_RUNTIME_MODE?.trim() || "combined",
  dbPath: process.env.WORKLIN_CONTROL_DB ?? "/data/control-plane.sqlite",
  sessionSecret: process.env.WORKLIN_SESSION_SECRET ?? "",
  actorSigningKey: process.env.ACTOR_TOKEN_SIGNING_KEY ?? "",
  auth0IssuerBaseUrl: trimTrailingSlash(
    process.env.AUTH0_ISSUER_BASE_URL ?? process.env.ISSUER_BASE_URL ?? "",
  ),
  // Hosted production uses the Vercel domain as the single public origin and
  // proxies `/callback`, `/_allauth/*`, and `/v1/*` back to Railway. Keep the
  // Auth0 callback on that hosted web origin so the session cookie lands on
  // the public app domain rather than becoming a third-party backend cookie.
  auth0BaseUrl: hostedWebBaseUrl,
  auth0ClientId: process.env.AUTH0_CLIENT_ID ?? process.env.CLIENT_ID ?? "",
  auth0ClientSecret: auth0ClientCredential,
  auth0Secret:
    process.env.AUTH0_SECRET ??
    process.env.SECRET ??
    process.env.WORKLIN_SESSION_SECRET ??
    "",
};
const runtimeStackConfig = runtimeStackConfigFromEnv(
  process.env,
  env.gatewayUrl,
  canonicalHostedWebOrigin(env.webOrigin) ?? env.webOrigin,
);
const railwayProvisionerConfig = railwayProvisionerConfigFromEnv(process.env);
const tenantRuntimeAdmissionConfig = tenantRuntimeAdmissionConfigFromEnv(
  process.env,
);
const tenantRuntimeOperationsConfig = tenantRuntimeOperationsConfigFromEnv(
  process.env,
);
const runtimeWorkerPoolConfig = runtimeWorkerPoolConfigFromEnv(process.env);
const runtimeWorkerCoordinatorOwnershipConfig =
  runtimeWorkerCoordinatorOwnershipConfigFromEnv(
    process.env,
    runtimeWorkerPoolConfig.enabled,
  );
const runtimeWorkerOperatorRecoveryConfig =
  runtimeWorkerOperatorRecoveryConfigFromEnv(
    process.env,
    runtimeWorkerPoolConfig.enabled,
  );

if (!env.sessionSecret || env.sessionSecret.length < 32) {
  throw new Error(
    "WORKLIN_SESSION_SECRET must be set to at least 32 characters.",
  );
}

if (!/^[0-9a-f]{64}$/i.test(env.actorSigningKey)) {
  throw new Error(
    "ACTOR_TOKEN_SIGNING_KEY must be 64 hex characters and shared with the gateway.",
  );
}

mkdirSync(dirname(env.dbPath), { recursive: true });
const db = new Database(env.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    consent_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS assistants (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    runtime_stack_id TEXT,
    isolation_version INTEGER NOT NULL DEFAULT 2,
    admin_access_consented INTEGER NOT NULL DEFAULT 0
      CHECK(admin_access_consented IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`);
ensureArtifactSharingSchema(db);
ensureAssistantStoreSchema(db);
ensureRuntimeStackSchema(db);
ensureTenantRuntimeAdmissionSchema(db);
ensureTenantRuntimeOperationsSchema(db);
const pooledModelKeyVault = new PooledModelKeyVault(
  db,
  pooledModelKeyVaultConfigFromEnv(process.env),
);
const runtimeWorkerCoordinatorOwnership = (() => {
  if (!runtimeWorkerCoordinatorOwnershipConfig.enabled) return null;
  const acquired = acquireRuntimeWorkerCoordinatorOwnership(
    db,
    {
      ownerId: randomUUID(),
      deploymentId: runtimeWorkerCoordinatorOwnershipConfig.deploymentId,
      replicaId: runtimeWorkerCoordinatorOwnershipConfig.replicaId,
    },
    Date.now(),
    runtimeWorkerCoordinatorOwnershipConfig.ownershipTtlMs,
    nowIso,
  );
  if (acquired.status !== "acquired") {
    throw new Error(
      "Pooled runtime singleton coordinator ownership is unavailable.",
    );
  }
  return new RuntimeWorkerCoordinatorOwnershipGuard(
    db,
    acquired.binding,
    Date.now,
  );
})();

let runtimeWorkerStartup: Awaited<
  ReturnType<typeof activatePooledRuntimeWorkersAtStartup>
>;
try {
  runtimeWorkerStartup = await activatePooledRuntimeWorkersAtStartup(
    db,
    process.env,
    {
      nowIso,
      ...(runtimeWorkerCoordinatorOwnership
        ? { coordinatorOwnership: runtimeWorkerCoordinatorOwnership }
        : {}),
    },
  );
} catch (error) {
  runtimeWorkerCoordinatorOwnership?.release(nowIso);
  throw error;
}

let runtimeWorkerCoordinator: ReturnType<
  typeof createRuntimeWorkerProductionCoordinatorFromEnv
>;
try {
  runtimeWorkerCoordinator = createRuntimeWorkerProductionCoordinatorFromEnv(
    db,
    process.env,
    {
      ...(runtimeWorkerCoordinatorOwnership
        ? { coordinatorOwnership: runtimeWorkerCoordinatorOwnership }
        : {}),
      resolveBootstrapInferenceProvider: ({ binding }) => {
        if (!pooledModelKeyVault.enabled) return null;
        // `list()` reads account identifiers only. Provider selection must never
        // decrypt a tenant key during assignment/bootstrap.
        const configuredProviders = pooledModelKeyVault.list({
          organizationId: binding.organizationId,
          userId: binding.userId,
          assistantId: binding.assistantId,
        });
        const providers = configuredProviders.filter(
          isRuntimeWorkerBootstrapInferenceProvider,
        );
        if (configuredProviders.length !== providers.length) {
          throw new Error(
            "Pooled runtime has a model provider that requires a dedicated runtime. Remove that API key or use a dedicated assistant runtime.",
          );
        }
        if (providers.length > 1) {
          throw new Error(
            "Pooled runtime has multiple model providers configured. Remove all but one API key before starting the assistant.",
          );
        }
        return providers.length === 1 ? providers[0]! : null;
      },
      onLeaseReady: (observation) => {
        const result = recordTrustedTenantStorageObservation(
          db,
          tenantRuntimeOperationsConfig,
          {
            organizationId: observation.identity.organizationId,
            userId: observation.identity.userId,
            assistantId: observation.identity.assistantId,
          },
          {
            observationId: [
              "state-restore",
              observation.workerStackId,
              observation.leaseGeneration,
              observation.stateGeneration,
            ].join(":"),
            workerStackId: observation.workerStackId,
            leaseToken: observation.leaseToken,
            source: "runtime_state_export",
            observedBytes: observation.observedBytes,
            observedAtMs: observation.observedAtMs,
          },
          observation.observedAtMs,
          nowIso,
        );
        if (result.status === "rejected") {
          throw new Error(
            "Trusted pooled runtime storage observation was rejected.",
          );
        }
      },
    },
  );
} catch (error) {
  runtimeWorkerCoordinatorOwnership?.release(nowIso);
  throw error;
}
const runtimeWorkerRequestAbortRegistry =
  new RuntimeWorkerCoordinatorRequestAbortRegistry();
const runtimeWorkerSessionLeases = new RuntimeWorkerSessionLeaseRegistry({
  coordinator: runtimeWorkerCoordinator,
  timer: runtimeWorkerSessionTimer(),
  onReleaseFailure: () => {
    console.error("pooled_runtime_held_session_release_failed");
  },
});
let runtimeWorkerCoordinatorHeartbeat: ReturnType<typeof setInterval> | null =
  null;
let runtimeWorkerCoordinatorFenced = false;

class RuntimeWorkerCoordinatorOwnershipLostError extends Error {}

function pooledCoordinatorOwnershipIsLive(): boolean {
  return (
    runtimeWorkerStartup.status === "active" &&
    runtimeWorkerCoordinatorOwnership?.isLive() === true
  );
}

function mintPooledModelKeyRequestCapability(
  tenant: {
    organizationId: string;
    userId: string;
    assistantId: string;
  },
  binding: RuntimeWorkerLeaseServiceBinding,
  requestId: string,
  nowMs: number,
): string {
  if (!pooledCoordinatorOwnershipIsLive()) {
    throw new RuntimeWorkerCoordinatorOwnershipLostError();
  }
  const capability = pooledModelKeyVault.mintRequestCapability(
    tenant,
    binding,
    requestId,
    nowMs,
  );
  if (!pooledCoordinatorOwnershipIsLive()) {
    pooledModelKeyVault.revokeRequestCapability(requestId);
    throw new RuntimeWorkerCoordinatorOwnershipLostError();
  }
  return capability;
}

async function fencePooledRuntimeCoordinator(reason: Error): Promise<void> {
  if (runtimeWorkerCoordinatorFenced) return;
  runtimeWorkerCoordinatorFenced = true;
  runtimeWorkerCoordinatorOwnership?.fence();
  if (runtimeWorkerCoordinatorHeartbeat) {
    clearInterval(runtimeWorkerCoordinatorHeartbeat);
    runtimeWorkerCoordinatorHeartbeat = null;
  }
  const abortedRequestCount = runtimeWorkerRequestAbortRegistry.abortAll(reason);
  const revokedCapabilityCount =
    pooledModelKeyVault.revokeAllRequestCapabilities();
  const fence = await runtimeWorkerCoordinator.fenceCoordinatorOwnership();
  console.error("runtime_worker_coordinator_ownership_lost", {
    abortedRequestCount,
    revokedCapabilityCount,
    quarantinedWorkerCount: fence.quarantinedWorkerCount,
    revocationFailureCount: fence.revocationFailureCount,
  });
}
ensureBrandResearchRunSchema(db);
ensureWorkspaceManagementSchema(db);

const useSecureCookies =
  env.apiOrigin.startsWith("https://") &&
  env.auth0BaseUrl.startsWith("https://");
const cookieSameSite: "None" | "Lax" = useSecureCookies ? "None" : "Lax";
const csrfCookieName = useSecureCookies
  ? SECURE_CSRF_COOKIE
  : LOCAL_CSRF_COOKIE;

interface UserRow {
  id: string;
  email: string;
  username: string;
  first_name: string;
  last_name: string;
  consent_json: string | null;
}

interface Auth0Claims {
  sub?: unknown;
  email?: unknown;
  name?: unknown;
  nickname?: unknown;
  given_name?: unknown;
  family_name?: unknown;
}

interface OidcRequest {
  oidc?: {
    isAuthenticated(): boolean;
    user?: Auth0Claims;
  };
}

interface OidcResponse {
  oidc?: {
    login(options?: {
      returnTo?: string;
      authorizationParams?: Record<string, string>;
    }): Promise<void>;
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function nowIso(): string {
  return new Date().toISOString();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function auth0Configured(): boolean {
  return !!(
    env.auth0IssuerBaseUrl &&
    env.auth0BaseUrl &&
    env.auth0ClientId &&
    env.auth0ClientSecret &&
    env.auth0Secret
  );
}

function authConfigPayload() {
  if (!auth0Configured()) {
    return { data: {}, meta: {}, status: 200 };
  }

  return {
    data: {
      socialaccount: {
        providers: [
          {
            id: "auth0",
            name: "Auth0",
            client_id: env.auth0ClientId,
            flows: ["login", "signup"],
          },
        ],
      },
    },
    meta: {},
    status: 200,
  };
}

function allowedWebOrigins(): Set<string> {
  return new Set([
    env.webOrigin,
    CANONICAL_VERCEL_WEB_ORIGIN,
    LEGACY_VERCEL_WEB_ORIGIN,
  ]);
}

function publicWebOrigin(): string {
  return canonicalHostedWebOrigin(env.webOrigin) ?? env.webOrigin;
}

function allowedOriginValue(origin: string): boolean {
  if (allowedWebOrigins().has(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function allowedOrigin(req: Request): string | null {
  const origin = req.headers.origin;
  if (!origin) return null;
  return allowedOriginValue(origin) ? origin : null;
}

function allowedRefererOrigin(req: Request): string | null {
  const referer = req.headers.referer;
  if (!referer) return null;
  try {
    const origin = new URL(referer).origin;
    return allowedOriginValue(origin) ? origin : null;
  } catch {
    return null;
  }
}

function setCorsHeaders(req: Request, res: Response): void {
  const origin = allowedOrigin(req);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    // Hosted assistant runtime routes rely on the platform user id header for
    // edge auth, so preflight must explicitly allow it.
    "Authorization,Content-Type,X-CSRFToken,X-Session-Token,Vellum-Device-Id,Vellum-Organization-Id,X-Vellum-Client-Id,X-Vellum-Interface-Id,X-Vellum-User-Id",
  );
  res.setHeader("Access-Control-Expose-Headers", "X-CSRFToken");
}

function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

function sendJson(
  req: Request,
  res: Response,
  body: unknown,
  status = 200,
): void {
  setCorsHeaders(req, res);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.status(status).type("application/json").send(JSON.stringify(body));
}

function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.cookie ?? "";
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (!name) continue;
    out[name] = decodeURIComponent(rest.join("="));
  }
  return out;
}

function cookie(name: string, value: string, opts: string): string {
  return `${name}=${encodeURIComponent(value)}; ${opts}`;
}

function cookieSecurityAttributes(): string {
  return useSecureCookies ? "Secure; SameSite=None" : "SameSite=Lax";
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; ${cookieSecurityAttributes()}`;
}

function sessionCookieValue(sessionId: string): string {
  return cookie(
    SESSION_COOKIE,
    sessionId,
    `Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; ${cookieSecurityAttributes()}`,
  );
}

function appendCookie(res: Response, value: string): void {
  res.append("Set-Cookie", value);
}

function ensureCsrf(req: Request, res: Response): string {
  const existing = parseCookies(req)[csrfCookieName];
  const csrf = existing || randomToken(24);
  appendCookie(
    res,
    cookie(
      csrfCookieName,
      csrf,
      `Path=/; Max-Age=2592000; ${cookieSecurityAttributes()}`,
    ),
  );
  res.setHeader("X-CSRFToken", csrf);
  return csrf;
}

function getSessionUser(req: Request): UserRow | null {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  if (!sessionId) return null;
  return db
    .query<UserRow, [string, number]>(
      `
      SELECT users.*
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.id = ? AND sessions.expires_at > ?
    `,
    )
    .get(sessionId, nowSeconds());
}

function getAuth0User(req: Request): UserRow | null {
  const oidc = (req as Request & OidcRequest).oidc;
  if (!oidc?.isAuthenticated() || !oidc.user) return null;
  return upsertAuth0User(oidc.user);
}

function requireUser(req: Request, res: Response): UserRow | null {
  const user = getAuth0User(req) ?? getSessionUser(req);
  if (user) return user;
  sendJson(
    req,
    res,
    { detail: "Authentication credentials were not provided." },
    401,
  );
  return null;
}

function checkCsrf(req: Request, form?: URLSearchParams): boolean {
  const cookieCsrf = parseCookies(req)[csrfCookieName];
  const submitted =
    req.headers["x-csrftoken"]?.toString() ??
    form?.get("csrfmiddlewaretoken") ??
    undefined;
  return !!cookieCsrf && !!submitted && safeEqual(cookieCsrf, submitted);
}

function checkProviderRedirectCsrf(
  req: Request,
  form: URLSearchParams,
): boolean {
  if (checkCsrf(req, form)) return true;

  // Hosted production login starts on Vercel and posts to Railway. Some
  // browsers decline to persist the backend-domain CSRF cookie during the
  // bootstrap fetch, and Safari may omit `Origin` on the top-level form POST,
  // which would otherwise dead-end login on a 403 despite the request
  // originating from our own allowed hosted page. Keep full double-submit CSRF
  // everywhere else; only this login-initiation endpoint falls back to an
  // allowlisted `Origin` / `Referer` check plus the submitted form token.
  const trustedSource = allowedOrigin(req) ?? allowedRefererOrigin(req);
  return !!trustedSource && !!form.get("csrfmiddlewaretoken");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function stringClaim(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function usernameFromEmail(email: string): string {
  return (
    email
      .split("@")[0]
      ?.replace(/[^a-zA-Z0-9_-]/g, "")
      .toLowerCase() || "user"
  );
}

function userPayload(user: UserRow) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    is_staff: false,
    first_name: user.first_name,
    last_name: user.last_name,
  };
}

function authenticatedPayload(user: UserRow) {
  return {
    data: {
      methods: [
        {
          at: nowIso(),
          method: "socialaccount",
          provider: "auth0",
          uid: user.email,
        },
      ],
      user: userPayload(user),
    },
    meta: { is_authenticated: true },
    status: 200,
  };
}

function unauthenticatedPayload() {
  return {
    data: { flows: [] },
    meta: { is_authenticated: false },
    status: 401,
  };
}

function getOrCreateOrganization(user: UserRow): OrganizationRow {
  return getOrCreateStoredOrganization(db, user.id, nowIso);
}

function getOrCreateAssistant(user: UserRow): AssistantRow {
  return getOrCreateStoredAssistant(db, user.id, nowIso);
}

function mintActorToken(
  runtimeStack: RuntimeStackRow,
  tenantContext: RuntimeTenantContext,
  collaboration?: {
    artifactId: string;
    role: "viewer" | "commenter" | "editor" | "owner";
  },
): string {
  const now = nowSeconds();
  const scopeProfile = collaboration
    ? collaboration.role === "viewer"
      ? "artifact_viewer_v1"
      : collaboration.role === "commenter"
        ? "artifact_commenter_v1"
        : "artifact_editor_v1"
    : "actor_client_v1";
  const claims = {
    iss: "vellum-auth",
    aud: "vellum-gateway",
    sub: `actor:${runtimeStack.assistant_id}:${tenantContext.actorId}`,
    scope_profile: scopeProfile,
    exp: now + (collaboration ? 5 * 60 : ACTOR_TOKEN_TTL_SECONDS),
    policy_epoch: POLICY_EPOCH,
    iat: now,
    jti: randomBytes(16).toString("hex"),
    tenant_context: runtimeTenantContextClaim(tenantContext),
    ...(collaboration
      ? {
          artifact_id: collaboration.artifactId,
          collaboration_role: collaboration.role,
        }
      : {}),
  };
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sigInput = `${header}.${payload}`;
  const runtimeSigningKey = deriveRuntimeActorSigningKey(
    env.actorSigningKey,
    runtimeStack.actor_signing_key_scope,
  );
  const sig = createHmac("sha256", Buffer.from(runtimeSigningKey, "hex"))
    .update(sigInput)
    .digest("base64url");
  return `${sigInput}.${sig}`;
}

function invitationTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function inviteUrl(token: string): string {
  return `${env.webOrigin}/assistant/invitations/${encodeURIComponent(token)}`;
}

async function verifyShareableArtifact(
  assistant: AssistantRow,
  user: UserRow,
  artifactId: string,
): Promise<boolean> {
  const runtimeStack = ensureRuntimeStackForAssistant(
    db,
    assistant,
    runtimeStackConfig,
    nowIso,
  );
  if (!isRuntimeStackRoutable(runtimeStack)) return false;
  const tenantContext = createRuntimeTenantContext(
    assistant,
    user.id,
    runtimeStack,
  );
  const target = new URL(runtimeStack.gateway_url);
  target.pathname = `/v1/assistants/${encodeURIComponent(assistant.id)}/shared-artifacts/${encodeURIComponent(artifactId)}/snapshot`;
  const headers = new Headers({
    Authorization: `Bearer ${mintActorToken(runtimeStack, tenantContext, {
      artifactId,
      role: "owner",
    })}`,
  });
  applyRuntimeTenantHeaders(headers, tenantContext);
  const response = await fetch(target, {
    headers,
  });
  return response.ok;
}

function runtimeStackForPayload(row: AssistantRow): RuntimeStackRow {
  return ensureRuntimeStackForAssistant(db, row, runtimeStackConfig, nowIso);
}

function pooledRuntimeEligible(runtimeStack: RuntimeStackRow): boolean {
  return (
    pooledCoordinatorOwnershipIsLive() &&
    selectRuntimeWorkerRoutingPolicy(
      runtimeStack,
      runtimeWorkerCoordinator.config,
      Date.now(),
    ).mode === "pooled"
  );
}

function assistantPayload(
  row: AssistantRow,
  user: UserRow,
  runtimeStack = runtimeStackForPayload(row),
) {
  const tenantContext = createRuntimeTenantContext(row, user.id, runtimeStack);
  const pooled = pooledRuntimeEligible(runtimeStack);
  return {
    id: row.id,
    name: row.name,
    handle: "worklin",
    description: "Worklin autonomous retention marketing assistant",
    configuration: {},
    status: pooled ? "active" : assistantApiStatusForRuntimeStack(runtimeStack),
    runtime_status: pooled ? "active" : runtimeStack.status,
    runtime_stack_id: runtimeStack.id,
    runtime_provider: pooled ? "pooled_worker" : runtimeStack.provider,
    runtime_last_health_status: pooled
      ? "ready"
      : runtimeStack.last_health_status,
    runtime_last_error: pooled ? null : runtimeStack.last_error,
    created: row.created_at,
    modified: row.updated_at,
    release_channel: "stable",
    current_release_version: null,
    machine_id: null,
    vembda_cluster_id: null,
    machine_size: null,
    provisioned_storage_gib: null,
    maintenance_mode: { enabled: false },
    is_local: false,
    ingress_url: pooled ? null : publicWebOrigin(),
    platform_actor_token: pooled
      ? null
      : mintActorToken(runtimeStack, tenantContext),
    access_consented: row.admin_access_consented === 1,
  };
}

const runtimeProvisioningScheduler = new BoundedKeyedTaskScheduler(
  railwayProvisionerConfig.maxConcurrentProvisioning,
);
const runtimeProvisioningLeaseRetryTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

function runtimeProvisioningConfigurationError(): string | null {
  if (runtimeStackConfig.runtimeStackUrlTemplate) return null;
  if (runtimeStackConfig.runtimeStackProvider !== "railway") {
    return `Unsupported runtime stack provider: ${runtimeStackConfig.runtimeStackProvider}.`;
  }
  return railwayProvisionerConfigurationError(railwayProvisionerConfig);
}

function controlPlaneOnlyConfigurationError(): string | null {
  if (!pooledCoordinatorOwnershipIsLive()) {
    const provisioningError = runtimeProvisioningConfigurationError();
    if (provisioningError) return provisioningError;
  }
  if (!runtimeStackConfig.requireIsolatedRuntime) {
    return "Control-plane-only mode requires isolated runtimes.";
  }
  if (runtimeStackConfig.allowLegacySharedRuntime) {
    return "Control-plane-only mode cannot allow the legacy shared runtime.";
  }
  return null;
}

function scheduleRuntimeProvisioningLeaseRetry(
  assistant: AssistantRow,
  stackId: string,
  retryAfterMs: number | null,
): void {
  if (runtimeProvisioningLeaseRetryTimers.has(stackId)) return;
  const delayMs = Math.max(
    1_000,
    (retryAfterMs ?? railwayProvisionerConfig.provisioningLeaseTtlMs) + 100,
  );
  const timer = setTimeout(() => {
    runtimeProvisioningLeaseRetryTimers.delete(stackId);
    const latest = getRuntimeStackById(db, stackId);
    if (latest) scheduleRuntimeProvisioning(assistant, latest);
  }, delayMs);
  timer.unref?.();
  runtimeProvisioningLeaseRetryTimers.set(stackId, timer);
}

function scheduleRuntimeProvisioning(
  assistant: AssistantRow,
  stack: RuntimeStackRow,
): void {
  if (
    pooledRuntimeEligible(stack) ||
    !assistantOwnerHasAcceptedConsent(assistant) ||
    stack.provider !== "railway" ||
    (stack.status !== "provisioning" && stack.status !== "failed") ||
    runtimeProvisioningConfigurationError() !== null ||
    runtimeProvisioningScheduler.has(stack.id)
  ) {
    return;
  }

  let current = getRuntimeStackById(db, stack.id);
  if (
    !current ||
    current.provider !== "railway" ||
    (current.status !== "provisioning" && current.status !== "failed")
  ) {
    return;
  }

  const leaseToken = randomUUID();
  const leaseClaim = claimRuntimeServiceProvisioningLease(
    db,
    current.id,
    railwayProvisionerConfig.maxRuntimeServices,
    leaseToken,
    Date.now(),
    railwayProvisionerConfig.provisioningLeaseTtlMs,
    nowIso,
  );
  if (!leaseClaim.stack) {
    return;
  }
  if (!leaseClaim.leaseAcquired) {
    scheduleRuntimeProvisioningLeaseRetry(
      assistant,
      current.id,
      leaseClaim.retryAfterMs,
    );
    return;
  }
  const retryTimer = runtimeProvisioningLeaseRetryTimers.get(current.id);
  if (retryTimer) clearTimeout(retryTimer);
  runtimeProvisioningLeaseRetryTimers.delete(current.id);
  current = leaseClaim.stack;

  current =
    prepareRuntimeStackActorSigningScope(db, current.id, nowIso) ?? current;
  markRuntimeStackProvisioning(db, current.id, nowIso, leaseToken);

  const task = runtimeProvisioningScheduler.schedule(current.id, async () => {
    const current = getRuntimeStackById(db, stack.id);
    if (
      !current ||
      current.provisioning_lease_token !== leaseToken ||
      (current.status !== "provisioning" && current.status !== "failed")
    ) {
      releaseRuntimeServiceProvisioningLease(db, stack.id, leaseToken, nowIso);
      return;
    }

    try {
      const workspaceCapacityError = railwayRuntimeWorkspaceCapacityError(
        current.service_ref,
        countAllocatedRuntimeServicesForOrganization(db, current.org_id),
        railwayProvisionerConfig.maxRuntimeServicesPerWorkspace ?? 1,
      );
      if (workspaceCapacityError) throw new Error(workspaceCapacityError);
      await provisionRailwayRuntime({
        assistant,
        stack: current,
        runtimeActorSigningKey: deriveRuntimeActorSigningKey(
          env.actorSigningKey,
          current.actor_signing_key_scope,
        ),
        allowServiceCreation: leaseClaim.serviceCreationAllowed,
        config: railwayProvisionerConfig,
        persistence: {
          renewLease: () =>
            renewRuntimeServiceProvisioningLease(
              db,
              current.id,
              leaseToken,
              Date.now(),
              railwayProvisionerConfig.provisioningLeaseTtlMs,
              nowIso,
            ),
          recordServiceCreateAttempt: (attemptedAt) =>
            recordRuntimeServiceCreateAttempt(
              db,
              current.id,
              attemptedAt,
              nowIso,
              leaseToken,
            ),
          recordVolumeCreateAttempt: (attemptedAt) =>
            recordRuntimeVolumeCreateAttempt(
              db,
              current.id,
              attemptedAt,
              nowIso,
              leaseToken,
            ),
          recordService: (serviceId) =>
            recordRuntimeStackService(
              db,
              current.id,
              serviceId,
              nowIso,
              leaseToken,
            ),
          recordVolume: (volumeId) =>
            recordRuntimeStackVolume(
              db,
              current.id,
              volumeId,
              nowIso,
              leaseToken,
            ),
          markActive: (gatewayUrl, healthStatus) =>
            markRuntimeStackActive(
              db,
              current.id,
              gatewayUrl,
              healthStatus,
              nowIso,
              leaseToken,
            ),
        },
      });
      console.log("runtime_stack_provisioned", {
        assistantId: assistant.id,
        runtimeStackId: current.id,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Runtime provisioning failed.";
      try {
        markRuntimeStackFailed(db, current.id, message, nowIso, leaseToken);
      } catch (leaseError) {
        console.warn("runtime_stack_failure_not_persisted_after_lease_loss", {
          assistantId: assistant.id,
          runtimeStackId: current.id,
          error:
            leaseError instanceof Error
              ? leaseError.message
              : String(leaseError),
        });
      }
      console.error("runtime_stack_provisioning_failed", {
        assistantId: assistant.id,
        runtimeStackId: current.id,
        error: message,
      });
    } finally {
      releaseRuntimeServiceProvisioningLease(
        db,
        current.id,
        leaseToken,
        nowIso,
      );
    }
  });
  void task.catch((error) => {
    console.error("runtime_stack_scheduler_failed", {
      assistantId: assistant.id,
      runtimeStackId: stack.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function assistantOwnerHasAcceptedConsent(assistant: AssistantRow): boolean {
  const owner = db
    .query<{ consent_json: string | null }, [string]>(
      "SELECT consent_json FROM users WHERE id = ?",
    )
    .get(assistant.user_id);
  return hasAcceptedAssistantConsent(owner?.consent_json ?? null);
}

function ensureAssistantRuntime(assistant: AssistantRow): RuntimeStackRow {
  const current = runtimeStackForPayload(assistant);
  if (pooledRuntimeEligible(current)) return current;

  const runtimeStack = claimPreprovisionedRuntimeStack(
    db,
    assistant,
    current,
    runtimeStackConfig,
    nowIso,
  );
  const provisioningError = runtimeProvisioningConfigurationError();
  if (provisioningError && runtimeStack.status === "provisioning") {
    markRuntimeStackFailed(
      db,
      runtimeStack.id,
      "Managed assistant runtime provisioning is unavailable.",
      nowIso,
    );
    return getRuntimeStackById(db, runtimeStack.id) ?? runtimeStack;
  }
  scheduleRuntimeProvisioning(assistant, runtimeStack);
  return getRuntimeStackById(db, runtimeStack.id) ?? runtimeStack;
}

function resumeRuntimeProvisioning(): void {
  // Runtime creation is lazy. Do not turn a process restart into a signup
  // sweep: assistants whose stacks were only created for a list response must
  // remain unprovisioned until their first real request. Failed stacks are
  // retried by the same request path, which also preserves the per-assistant
  // idempotency boundary.
}

function operationalStatusPayload(
  row: AssistantRow,
  runtimeStack = runtimeStackForPayload(row),
) {
  const updatedAt = nowIso();
  const pooled = pooledRuntimeEligible(runtimeStack);
  const state = pooled
    ? "active"
    : operationalStateForRuntimeStack(runtimeStack);
  const runtimeReady = pooled || state === "active";
  return {
    state,
    detail_state: pooled ? "active" : runtimeStack.status,
    poll_after_ms: runtimeReady ? 30_000 : 5_000,
    updated_at: updatedAt,
    active_operation: null,
    assistant: {
      id: row.id,
      name: row.name,
      status: pooled
        ? "active"
        : assistantApiStatusForRuntimeStack(runtimeStack),
    },
    pod: {
      phase: runtimeReady ? "running" : "pending",
      ready: runtimeReady,
      restart_count: 0,
    },
    runtime: {
      reachable: runtimeReady,
    },
    detail: {
      reason: runtimeReady ? null : runtimeStack.status,
      message: runtimeReady
        ? null
        : (runtimeStack.last_error ??
          "Your assistant runtime is being prepared."),
    },
  };
}

function upsertAuth0User(claims: Auth0Claims): UserRow {
  const sub = stringClaim(claims.sub);
  const email =
    stringClaim(claims.email) ||
    `${sub.replace(/[^a-zA-Z0-9_-]/g, "") || "user"}@auth0.local`;
  const firstName = stringClaim(claims.given_name);
  const lastName = stringClaim(claims.family_name);
  const username =
    usernameFromEmail(email) ||
    stringClaim(claims.nickname) ||
    usernameFromEmail(stringClaim(claims.name));
  return upsertUser(email, username, firstName, lastName);
}

function upsertUser(
  email: string,
  username: string,
  firstName: string,
  lastName: string,
): UserRow {
  const existing = db
    .query<UserRow, [string]>("SELECT * FROM users WHERE email = ?")
    .get(email);
  const timestamp = nowIso();
  if (existing) {
    db.query(
      "UPDATE users SET username = ?, first_name = ?, last_name = ?, updated_at = ? WHERE id = ?",
    ).run(username, firstName, lastName, timestamp, existing.id);
    return {
      ...existing,
      username,
      first_name: firstName,
      last_name: lastName,
    };
  }
  const user: UserRow = {
    id: randomUUID(),
    email,
    username,
    first_name: firstName,
    last_name: lastName,
    consent_json: null,
  };
  db.query(
    "INSERT INTO users (id, email, username, first_name, last_name, consent_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    user.id,
    user.email,
    user.username,
    user.first_name,
    user.last_name,
    null,
    timestamp,
    timestamp,
  );
  return user;
}

function parseTextBody(req: Request): string {
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body === "object") {
    return new URLSearchParams(req.body as Record<string, string>).toString();
  }
  return "";
}

function parseJsonBody<T>(req: Request): T | null {
  const text = parseTextBody(req).trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function createSession(userId: string): string {
  const id = randomToken(32);
  db.query(
    "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  ).run(id, userId, nowSeconds() + SESSION_TTL_SECONDS, nowIso());
  return id;
}

function ensureUserSessionCookie(
  req: Request,
  res: Response,
  user: UserRow,
): void {
  const existingUser = getSessionUser(req);
  if (existingUser?.id === user.id) return;
  appendCookie(res, sessionCookieValue(createSession(user.id)));
}

function isAllowedCallbackUrl(value: string): boolean {
  try {
    const parsed = new URL(value, env.webOrigin);
    return allowedOriginValue(parsed.origin);
  } catch {
    return false;
  }
}

async function handleSession(req: Request, res: Response): Promise<void> {
  ensureCsrf(req, res);
  if (req.method === "DELETE") {
    const sessionId = parseCookies(req)[SESSION_COOKIE];
    if (sessionId) {
      db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
    }
    appendCookie(res, clearCookie(SESSION_COOKIE));
    sendJson(req, res, {
      data: {},
      meta: { is_authenticated: false },
      status: 200,
    });
    return;
  }

  const user = getAuth0User(req) ?? getSessionUser(req);
  if (user) {
    ensureUserSessionCookie(req, res, user);
    getOrCreateOrganization(user);
    // A Worklin account always owns a default assistant identity. Runtime
    // provisioning remains lazy, so session bootstrap itself cannot allocate
    // external infrastructure.
    getOrCreateAssistant(user);
    sendJson(req, res, authenticatedPayload(user));
    return;
  }
  sendJson(req, res, unauthenticatedPayload(), 401);
}

async function handleProviderRedirect(
  req: Request,
  res: Response,
): Promise<void> {
  const form = new URLSearchParams(parseTextBody(req));
  if (!checkProviderRedirectCsrf(req, form)) {
    sendJson(
      req,
      res,
      { errors: [{ code: "csrf_failed", message: "CSRF validation failed." }] },
      403,
    );
    return;
  }
  if (!auth0Configured() || !(res as Response & OidcResponse).oidc) {
    sendJson(req, res, { detail: "Auth0 is not configured." }, 503);
    return;
  }

  const callbackUrl =
    form.get("callback_url") ||
    `${publicWebOrigin()}/account/provider/callback`;
  if (!isAllowedCallbackUrl(callbackUrl)) {
    sendJson(req, res, { detail: "Callback URL is not allowed." }, 400);
    return;
  }

  const authorizationParams: Record<string, string> = {
    scope: "openid profile email",
  };
  if (form.get("intent") === "signup") {
    authorizationParams.screen_hint = "signup";
  }
  const providerHint = form.get("provider_hint");
  if (providerHint) {
    authorizationParams.connection = providerHint;
  }

  await (res as Response & OidcResponse).oidc!.login({
    returnTo: callbackUrl,
    authorizationParams,
  });
}

async function handleUserMe(
  req: Request,
  res: Response,
  user: UserRow,
): Promise<void> {
  if (req.method === "PATCH") {
    if (!checkCsrf(req)) {
      sendJson(req, res, { detail: "CSRF validation failed." }, 403);
      return;
    }
    const body =
      parseJsonBody<{ username?: string; consent?: unknown }>(req) ?? {};
    const nextUsername = body.username?.trim() || user.username;
    const consentJson =
      body.consent === undefined
        ? user.consent_json
        : JSON.stringify(body.consent);
    db.query(
      "UPDATE users SET username = ?, consent_json = ?, updated_at = ? WHERE id = ?",
    ).run(nextUsername, consentJson, nowIso(), user.id);
    user = { ...user, username: nextUsername, consent_json: consentJson };
  }
  sendJson(req, res, {
    ...userPayload(user),
    consent: user.consent_json ? JSON.parse(user.consent_json) : null,
  });
}

function handleOrganizations(req: Request, res: Response, user: UserRow): void {
  let organizations = listWorkspaceOrganizationsForUser(db, user.id);
  if (organizations.length === 0) {
    getOrCreateOrganization(user);
    organizations = listWorkspaceOrganizationsForUser(db, user.id);
  }
  const results = organizations.map(({ id, name }) => ({ id, name }));
  sendJson(req, res, {
    count: results.length,
    next: null,
    previous: null,
    results,
  });
}

class WorkspaceAccessError extends Error {
  constructor(message = "This workspace membership is inactive.") {
    super(message);
    this.name = "WorkspaceAccessError";
  }
}

function requestedWorkspaceId(req: Request): string | null {
  return req.get("Vellum-Organization-Id")?.trim() || null;
}

function workspaceContext(req: Request, user: UserRow) {
  const requestedOrgId = requestedWorkspaceId(req);
  const selected = getWorkspaceOrganizationContext(db, user.id, requestedOrgId);
  if (selected) {
    if (selected.membership.status !== "active") {
      throw new WorkspaceAccessError();
    }
    return {
      org: selected.organization,
      membership: selected.membership,
    };
  }

  if (requestedOrgId) {
    throw new WorkspaceAccessError("You do not have access to this workspace.");
  }

  const inactiveMembership = db
    .query<OrganizationMembershipRow, [string]>(
      `SELECT * FROM organization_memberships
       WHERE user_id = ? AND status = 'deactivated'
       ORDER BY created_at LIMIT 1`,
    )
    .get(user.id);
  if (inactiveMembership) {
    throw new WorkspaceAccessError();
  }

  const org = getOrCreateStoredOrganization(db, user.id, nowIso);
  const ownerMembership =
    getOrganizationMembership(db, org.id, user.id) ??
    getOrCreateOrganizationMembership(db, org.id, user.id, "admin", nowIso);
  return { org, membership: ownerMembership };
}

function workspaceMemberPayload(
  member: ReturnType<typeof listWorkspaceMembers>[number],
) {
  return {
    user_id: member.user_id,
    email: member.email,
    username: member.username,
    first_name: member.first_name,
    last_name: member.last_name,
    role: member.role,
    status: member.status,
    created_at: member.created_at,
    updated_at: member.updated_at,
  };
}

function isOrganizationRole(value: unknown): value is OrganizationRole {
  return value === "admin" || value === "manager" || value === "collaborator";
}

async function handleWorkspace(
  req: Request,
  res: Response,
  url: URL,
  user: UserRow,
): Promise<boolean> {
  if (!pathIsOrStartsWith(url.pathname, "/v1/workspace")) return false;

  const inviteAcceptMatch =
    /^\/v1\/workspace\/invitations\/([^/]+)\/accept\/?$/.exec(url.pathname);
  if (inviteAcceptMatch && req.method === "POST") {
    if (!checkCsrf(req)) {
      sendJson(req, res, { detail: "CSRF validation failed." }, 403);
      return true;
    }
    try {
      const membership = acceptWorkspaceInvitationForUser(
        db,
        decodeURIComponent(inviteAcceptMatch[1]!),
        { id: user.id, email: user.email },
        new Date(),
      );
      sendJson(req, res, membership);
    } catch (error) {
      sendJson(
        req,
        res,
        {
          detail:
            error instanceof Error
              ? error.message
              : "Invitation could not be accepted.",
        },
        400,
      );
    }
    return true;
  }

  const context = workspaceContext(req, user);

  if (pathEquals(url.pathname, "/v1/workspace/") && req.method === "GET") {
    const assignments = listAssistantAssignments(db, context.org.id);
    const accessibleIds = new Set(
      listAccessibleAssistantIds(
        db,
        context.org.id,
        user.id,
        context.membership.role,
      ),
    );
    const assistants = db
      .query<
        Pick<AssistantRow, "id" | "name" | "user_id" | "org_id">,
        [string]
      >(
        "SELECT id, name, user_id, org_id FROM assistants WHERE org_id = ? ORDER BY created_at, id",
      )
      .all(context.org.id)
      .filter((assistant) => accessibleIds.has(assistant.id));
    const visibleAssignments =
      context.membership.role === "admin" ||
      context.membership.role === "manager"
        ? assignments
        : assignments.filter((assignment) => assignment.user_id === user.id);
    sendJson(req, res, {
      organization: {
        id: context.org.id,
        name: context.org.name,
        owner_user_id: context.org.user_id,
      },
      current_user: {
        user_id: user.id,
        role: context.membership.role,
      },
      members: listWorkspaceMembers(db, context.org.id).map(
        workspaceMemberPayload,
      ),
      assistants,
      assignments: visibleAssignments,
      research_providers: listWorkspaceResearchProviders(db, context.org.id),
      invitations:
        context.membership.role === "admin"
          ? listPendingWorkspaceInvitations(db, context.org.id, new Date())
          : [],
    });
    return true;
  }

  const researchProviderMatch =
    /^\/v1\/workspace\/research-providers\/([^/]+)\/?$/.exec(url.pathname);
  if (
    researchProviderMatch &&
    (req.method === "POST" || req.method === "DELETE")
  ) {
    if (!canManageMembers(context.membership.role)) {
      sendJson(
        req,
        res,
        { detail: "Only workspace admins can manage research providers." },
        403,
      );
      return true;
    }
    if (!checkCsrf(req)) {
      sendJson(req, res, { detail: "CSRF validation failed." }, 403);
      return true;
    }
    const providerId = decodeURIComponent(researchProviderMatch[1]!);
    if (!isWorkspaceResearchProviderId(providerId)) {
      sendJson(req, res, { detail: "Unsupported research provider." }, 400);
      return true;
    }
    if (req.method === "DELETE") {
      sendJson(req, res, {
        ok: deleteWorkspaceResearchProviderCredential(
          db,
          context.org.id,
          providerId,
        ),
      });
      return true;
    }
    const body = parseJsonBody<{ credential?: string }>(req) ?? {};
    try {
      const provider = saveWorkspaceResearchProviderCredential(
        db,
        {
          orgId: context.org.id,
          providerId,
          credential: body.credential ?? "",
        },
        env.actorSigningKey,
        nowIso,
      );
      sendJson(req, res, provider, 201);
    } catch (error) {
      sendJson(
        req,
        res,
        {
          detail:
            error instanceof Error
              ? error.message
              : "Provider could not be connected.",
        },
        400,
      );
    }
    return true;
  }

  const revokeInviteMatch =
    /^\/v1\/workspace\/invitations\/([^/]+)\/revoke\/?$/.exec(url.pathname);
  if (revokeInviteMatch && req.method === "POST") {
    if (!canManageMembers(context.membership.role)) {
      sendJson(
        req,
        res,
        { detail: "Only workspace admins can revoke invites." },
        403,
      );
      return true;
    }
    if (!checkCsrf(req)) {
      sendJson(req, res, { detail: "CSRF validation failed." }, 403);
      return true;
    }
    const revoked = revokeWorkspaceInvitation(
      db,
      context.org.id,
      decodeURIComponent(revokeInviteMatch[1]!),
    );
    sendJson(req, res, { ok: revoked });
    return true;
  }

  if (
    pathEquals(url.pathname, "/v1/workspace/members/invite/") &&
    req.method === "POST"
  ) {
    if (!canManageMembers(context.membership.role)) {
      sendJson(
        req,
        res,
        { detail: "Only workspace admins can invite members." },
        403,
      );
      return true;
    }
    if (!checkCsrf(req)) {
      sendJson(req, res, { detail: "CSRF validation failed." }, 403);
      return true;
    }
    const body = parseJsonBody<{ email?: string; role?: unknown }>(req) ?? {};
    if (!isOrganizationRole(body.role) || !body.email?.trim()) {
      sendJson(
        req,
        res,
        { detail: "Email and a valid role are required." },
        400,
      );
      return true;
    }
    try {
      const invitation = createWorkspaceInvitation(
        db,
        {
          orgId: context.org.id,
          invitedByUserId: user.id,
          email: body.email,
          role: body.role,
        },
        new Date(),
      );
      sendJson(
        req,
        res,
        {
          id: invitation.id,
          role: body.role,
          expires_at: invitation.expiresAt,
          invite_url: `${publicWebOrigin()}/assistant/workspace/invitations/${encodeURIComponent(invitation.token)}`,
        },
        201,
      );
    } catch (error) {
      sendJson(
        req,
        res,
        {
          detail:
            error instanceof Error
              ? error.message
              : "Invitation could not be created.",
        },
        400,
      );
    }
    return true;
  }

  const roleMatch = /^\/v1\/workspace\/members\/([^/]+)\/role\/?$/.exec(
    url.pathname,
  );
  if (roleMatch && req.method === "PATCH") {
    if (!canManageMembers(context.membership.role)) {
      sendJson(
        req,
        res,
        { detail: "Only workspace admins can change roles." },
        403,
      );
      return true;
    }
    if (!checkCsrf(req)) {
      sendJson(req, res, { detail: "CSRF validation failed." }, 403);
      return true;
    }
    const body = parseJsonBody<{ role?: unknown }>(req) ?? {};
    if (!isOrganizationRole(body.role)) {
      sendJson(req, res, { detail: "A valid role is required." }, 400);
      return true;
    }
    try {
      const member = setWorkspaceMemberRole(
        db,
        context.org.id,
        decodeURIComponent(roleMatch[1]!),
        body.role,
        context.org.user_id,
        nowIso,
      );
      sendJson(req, res, member);
    } catch (error) {
      sendJson(
        req,
        res,
        {
          detail:
            error instanceof Error
              ? error.message
              : "Role could not be changed.",
        },
        400,
      );
    }
    return true;
  }

  const memberMatch = /^\/v1\/workspace\/members\/([^/]+)\/?$/.exec(
    url.pathname,
  );
  if (memberMatch && req.method === "DELETE") {
    if (!canManageMembers(context.membership.role)) {
      sendJson(
        req,
        res,
        { detail: "Only workspace admins can remove members." },
        403,
      );
      return true;
    }
    if (!checkCsrf(req)) {
      sendJson(req, res, { detail: "CSRF validation failed." }, 403);
      return true;
    }
    try {
      deactivateWorkspaceMember(
        db,
        context.org.id,
        decodeURIComponent(memberMatch[1]!),
        context.org.user_id,
        nowIso,
      );
      sendJson(req, res, { ok: true });
    } catch (error) {
      sendJson(
        req,
        res,
        {
          detail:
            error instanceof Error
              ? error.message
              : "Member could not be removed.",
        },
        400,
      );
    }
    return true;
  }

  if (
    pathEquals(url.pathname, "/v1/workspace/assistants/assignments/") &&
    req.method === "POST"
  ) {
    if (!canManageAssignments(context.membership.role)) {
      sendJson(
        req,
        res,
        { detail: "You do not have permission to assign assistants." },
        403,
      );
      return true;
    }
    if (!checkCsrf(req)) {
      sendJson(req, res, { detail: "CSRF validation failed." }, 403);
      return true;
    }
    const body =
      parseJsonBody<{ assistantId?: string; userId?: string }>(req) ?? {};
    const assistant = body.assistantId
      ? db
          .query<AssistantRow, [string, string]>(
            "SELECT * FROM assistants WHERE id = ? AND org_id = ?",
          )
          .get(body.assistantId, context.org.id)
      : null;
    const member = body.userId
      ? getOrganizationMembership(db, context.org.id, body.userId)
      : null;
    if (!assistant || !member || member.status !== "active") {
      sendJson(
        req,
        res,
        { detail: "Assistant and active member are required." },
        400,
      );
      return true;
    }
    sendJson(
      req,
      res,
      assignAssistant(db, context.org.id, assistant.id, member.user_id, nowIso),
      201,
    );
    return true;
  }

  if (
    pathEquals(url.pathname, "/v1/workspace/assistants/assignments/") &&
    req.method === "DELETE"
  ) {
    if (!canManageAssignments(context.membership.role)) {
      sendJson(
        req,
        res,
        { detail: "You do not have permission to assign assistants." },
        403,
      );
      return true;
    }
    if (!checkCsrf(req)) {
      sendJson(req, res, { detail: "CSRF validation failed." }, 403);
      return true;
    }
    const body =
      parseJsonBody<{ assistantId?: string; userId?: string }>(req) ?? {};
    if (!body.assistantId || !body.userId) {
      sendJson(req, res, { detail: "Assistant and member are required." }, 400);
      return true;
    }
    unassignAssistant(db, context.org.id, body.assistantId, body.userId);
    sendJson(req, res, { ok: true });
    return true;
  }

  sendJson(req, res, { detail: "Workspace route not found." }, 404);
  return true;
}

async function handleBrandResearchRuns(
  req: Request,
  res: Response,
  url: URL,
  user: UserRow,
): Promise<boolean> {
  if (
    pathEquals(url.pathname, "/v1/brand-research/runs/") &&
    req.method === "GET"
  ) {
    const results = listBrandResearchRunsForUser(db, user.id).map(
      brandResearchRunPayload,
    );
    sendJson(req, res, {
      count: results.length,
      next: null,
      previous: null,
      results,
    });
    return true;
  }

  if (
    pathEquals(url.pathname, "/v1/brand-research/runs/") &&
    req.method === "POST"
  ) {
    if (!checkCsrf(req)) {
      sendJson(req, res, { detail: "CSRF validation failed." }, 403);
      return true;
    }
    const body =
      parseJsonBody<{
        assistantId?: string;
        brandName?: string;
        websiteUrl?: string;
      }>(req) ?? {};
    const assistant = body.assistantId
      ? accessibleAssistantsForUser(req, user).find(
          (candidate) => candidate.id === body.assistantId,
        )
      : accessibleAssistantsForUser(req, user)[0];
    if (!assistant) {
      sendJson(req, res, { detail: "Assistant not found." }, 404);
      return true;
    }
    try {
      const run = createOrGetBrandResearchRun(
        db,
        {
          orgId: assistant.org_id,
          userId: user.id,
          assistantId: assistant.id,
          brandName: body.brandName,
          websiteUrl: body.websiteUrl,
        },
        nowIso,
      );
      sendJson(req, res, brandResearchRunPayload(run), 202);
    } catch (error) {
      sendJson(
        req,
        res,
        {
          detail:
            error instanceof Error ? error.message : "Invalid brand seed.",
        },
        400,
      );
    }
    return true;
  }

  const detailMatch = /^\/v1\/brand-research\/runs\/([^/]+)\/?$/.exec(
    url.pathname,
  );
  if (detailMatch && req.method === "GET") {
    const run = getBrandResearchRunForUser(db, detailMatch[1]!, user.id);
    if (!run) {
      sendJson(req, res, { detail: "Research run not found." }, 404);
      return true;
    }
    sendJson(req, res, brandResearchRunPayload(run));
    return true;
  }

  const cancelMatch = /^\/v1\/brand-research\/runs\/([^/]+)\/cancel\/?$/.exec(
    url.pathname,
  );
  if (cancelMatch && req.method === "POST") {
    if (!checkCsrf(req)) {
      sendJson(req, res, { detail: "CSRF validation failed." }, 403);
      return true;
    }
    const run = getBrandResearchRunForUser(db, cancelMatch[1]!, user.id);
    if (!run) {
      sendJson(req, res, { detail: "Research run not found." }, 404);
      return true;
    }
    markBrandResearchRunCancelled(db, run.id, nowIso);
    const updated = getBrandResearchRunForUser(db, run.id, user.id);
    sendJson(req, res, updated ? brandResearchRunPayload(updated) : null);
    return true;
  }

  return false;
}

function accessibleAssistantsForUser(
  req: Request,
  user: UserRow,
): AssistantRow[] {
  const workspace = workspaceContext(req, user);
  if (workspace.org.user_id === user.id) {
    const existing = db
      .query<AssistantRow, [string]>(
        "SELECT * FROM assistants WHERE org_id = ? ORDER BY created_at, id",
      )
      .all(workspace.org.id);
    if (existing.length === 0) getOrCreateAssistant(user);
  }
  const accessibleIds = new Set(
    listAccessibleAssistantIds(
      db,
      workspace.org.id,
      user.id,
      workspace.membership.role,
    ),
  );
  return db
    .query<AssistantRow, [string]>(
      "SELECT * FROM assistants WHERE org_id = ? ORDER BY created_at, id",
    )
    .all(workspace.org.id)
    .filter((assistant) => accessibleIds.has(assistant.id));
}

async function handleAssistants(
  req: Request,
  res: Response,
  url: URL,
  user: UserRow,
): Promise<boolean> {
  if (pathEquals(url.pathname, "/v1/assistants/") && req.method === "GET") {
    const assistants = accessibleAssistantsForUser(req, user);
    const hosting = url.searchParams.get("hosting");
    const includeAssistant =
      hosting === null || hosting === "platform" || hosting === "all";
    if (!includeAssistant) {
      sendJson(req, res, { count: 0, next: null, previous: null, results: [] });
      return true;
    }
    const results = assistants.map((assistant) =>
      assistantPayload(assistant, user, runtimeStackForPayload(assistant)),
    );
    sendJson(req, res, {
      count: results.length,
      next: null,
      previous: null,
      results,
    });
    return true;
  }

  const accessConsentMatch =
    /^\/v1\/assistants\/([^/]+)\/access-consent\/?$/.exec(url.pathname);
  if (accessConsentMatch) {
    const assistantId = accessConsentMatch[1]!;
    const workspace = workspaceContext(req, user);
    const assistant = accessibleAssistantsForUser(req, user).find(
      (candidate) => candidate.id === assistantId,
    );
    if (!assistant || assistant.org_id !== workspace.org.id) {
      sendJson(req, res, { detail: "Assistant not found." }, 404);
      return true;
    }
    const currentConsent = getAssistantAdminAccessConsent(
      db,
      assistantId,
      workspace.org.id,
    );
    if (currentConsent === null) {
      sendJson(req, res, { detail: "Assistant not found." }, 404);
      return true;
    }
    const canUpdateConsent =
      assistant.user_id === user.id || workspace.membership.role === "admin";

    if (req.method === "GET") {
      sendJson(req, res, {
        access_consented: currentConsent,
        can_update: canUpdateConsent,
      });
      return true;
    }

    if (req.method === "PATCH") {
      if (!canUpdateConsent) {
        sendJson(
          req,
          res,
          {
            detail:
              "Only the assistant owner or a workspace admin can change admin access.",
          },
          403,
        );
        return true;
      }
      if (!checkCsrf(req)) {
        sendJson(req, res, { detail: "CSRF validation failed." }, 403);
        return true;
      }
      const body = parseJsonBody<{ access_consented?: unknown }>(req) ?? {};
      if (typeof body.access_consented !== "boolean") {
        sendJson(
          req,
          res,
          { detail: "access_consented must be a boolean." },
          400,
        );
        return true;
      }
      const updated = setAssistantAdminAccessConsent(
        db,
        assistantId,
        workspace.org.id,
        body.access_consented,
        nowIso,
      );
      if (updated === null) {
        sendJson(req, res, { detail: "Assistant not found." }, 404);
        return true;
      }
      sendJson(req, res, { access_consented: updated, can_update: true });
      return true;
    }

    res.setHeader("Allow", "GET, PATCH");
    sendJson(req, res, { detail: "Method not allowed." }, 405);
    return true;
  }

  if (
    pathEquals(url.pathname, "/v1/assistants/active/") &&
    req.method === "GET"
  ) {
    const assistant = accessibleAssistantsForUser(req, user)[0];
    if (!assistant) {
      sendJson(
        req,
        res,
        { detail: "No assistant has been assigned to you." },
        404,
      );
      return true;
    }
    const runtimeStack = runtimeStackForPayload(assistant);
    sendJson(req, res, assistantPayload(assistant, user, runtimeStack));
    return true;
  }

  if (
    pathEquals(url.pathname, "/v1/assistants/hatch/") &&
    req.method === "POST"
  ) {
    if (!checkCsrf(req)) {
      sendJson(req, res, { detail: "CSRF validation failed." }, 403);
      return true;
    }
    if (!hasAcceptedAssistantConsent(user.consent_json)) {
      sendJson(
        req,
        res,
        {
          detail:
            "Accept the current terms, privacy policy, and AI data policy before preparing your assistant.",
          code: "assistant_consent_required",
        },
        403,
      );
      return true;
    }
    const workspace = workspaceContext(req, user);
    const existing =
      workspace.org.user_id === user.id
        ? db
            .query<AssistantRow, [string]>(
              "SELECT * FROM assistants WHERE org_id = ? ORDER BY created_at, id",
            )
            .get(workspace.org.id)
        : accessibleAssistantsForUser(req, user)[0];
    const assistant =
      existing ??
      (workspace.org.user_id === user.id ? getOrCreateAssistant(user) : null);
    if (!assistant) {
      sendJson(
        req,
        res,
        { detail: "A workspace admin must assign an assistant before hatch." },
        403,
      );
      return true;
    }
    const baseRuntimeStack = runtimeStackForPayload(assistant);
    const runtimeStack = pooledRuntimeEligible(baseRuntimeStack)
      ? baseRuntimeStack
      : claimPreprovisionedRuntimeStack(
          db,
          assistant,
          baseRuntimeStack,
          runtimeStackConfig,
          nowIso,
        );
    const provisioningError = runtimeProvisioningConfigurationError();
    if (
      !pooledRuntimeEligible(runtimeStack) &&
      (runtimeStack.status === "provisioning" ||
        runtimeStack.status === "failed") &&
      provisioningError
    ) {
      sendJson(
        req,
        res,
        {
          detail: "Managed assistant provisioning is not available.",
          code: "platform_hosted_disabled",
          runtime_status: runtimeStack.status,
          runtime_stack_id: runtimeStack.id,
          runtime_last_error: runtimeStack.last_error,
        },
        503,
      );
      return true;
    }
    sendJson(
      req,
      res,
      assistantPayload(assistant, user, runtimeStack),
      existing ? 200 : 201,
    );
    return true;
  }

  const restartMatch = /^\/v1\/assistants\/([^/]+)\/restart\/?$/.exec(
    url.pathname,
  );
  if (restartMatch && req.method === "POST") {
    const assistant = accessibleAssistantsForUser(req, user).find(
      (candidate) => candidate.id === restartMatch[1],
    );
    if (!assistant) {
      sendJson(req, res, { detail: "Assistant not found." }, 404);
      return true;
    }
    if (!checkCsrf(req)) {
      sendJson(req, res, { detail: "CSRF validation failed." }, 403);
      return true;
    }
    if (!hasAcceptedAssistantConsent(user.consent_json)) {
      sendJson(
        req,
        res,
        { detail: "Assistant consent must be accepted before use." },
        403,
      );
      return true;
    }

    const currentRuntimeStack = runtimeStackForPayload(assistant);
    if (isRuntimeStackRoutable(currentRuntimeStack)) {
      // Preserve the existing restart behavior for a healthy runtime by
      // forwarding the request to its gateway.
      return false;
    }

    if (!assistantOwnerHasAcceptedConsent(assistant)) {
      sendJson(
        req,
        res,
        {
          detail:
            "The assistant owner must accept the current consent terms before restarting it.",
          code: "assistant_owner_consent_required",
        },
        409,
      );
      return true;
    }

    const runtimeStack = ensureAssistantRuntime(assistant);
    if (isRuntimeStackRoutable(runtimeStack)) {
      // A reserved runtime slot can become active during this retry.
      return false;
    }

    if (runtimeStack.provider !== "railway") {
      sendJson(
        req,
        res,
        {
          detail: "This assistant runtime cannot be restarted automatically.",
          code: "runtime_not_retryable",
          runtime_status: runtimeStack.status,
          runtime_stack_id: runtimeStack.id,
        },
        503,
      );
      return true;
    }

    const provisioningError = runtimeProvisioningConfigurationError();
    if (provisioningError) {
      sendJson(
        req,
        res,
        {
          detail: "Managed assistant provisioning is not available.",
          code: "platform_hosted_disabled",
          runtime_status: runtimeStack.status,
          runtime_stack_id: runtimeStack.id,
        },
        503,
      );
      return true;
    }

    if (
      runtimeStack.status === "provisioning" ||
      runtimeStack.status === "failed"
    ) {
      sendJson(
        req,
        res,
        {
          detail: "Assistant runtime restart requested.",
          code: "runtime_provisioning",
          runtime_status: runtimeStack.status,
          runtime_stack_id: runtimeStack.id,
        },
        202,
      );
      return true;
    }

    sendJson(req, res, runtimeNotReadyPayload(runtimeStack), 503);
    return true;
  }

  const operationalStatusMatch =
    /^\/v1\/assistants\/([^/]+)\/operational\/status\/?$/.exec(url.pathname);
  if (operationalStatusMatch && req.method === "GET") {
    const assistant = accessibleAssistantsForUser(req, user).find(
      (candidate) => candidate.id === operationalStatusMatch[1],
    );
    if (!assistant) {
      sendJson(req, res, { detail: "Assistant not found." }, 404);
      return true;
    }
    sendJson(req, res, operationalStatusPayload(assistant));
    return true;
  }

  const assistantMatch = /^\/v1\/assistants\/([^/]+)\/?$/.exec(url.pathname);
  if (assistantMatch) {
    const assistant = accessibleAssistantsForUser(req, user).find(
      (candidate) => candidate.id === assistantMatch[1],
    );
    if (!assistant) {
      sendJson(req, res, { detail: "Assistant not found." }, 404);
      return true;
    }
    if (req.method === "PATCH") {
      const workspace = workspaceContext(req, user);
      if (
        assistant.user_id !== user.id &&
        workspace.membership.role !== "admin"
      ) {
        sendJson(
          req,
          res,
          {
            detail:
              "Only the assistant owner or a workspace admin can rename it.",
          },
          403,
        );
        return true;
      }
      if (!checkCsrf(req)) {
        sendJson(req, res, { detail: "CSRF validation failed." }, 403);
        return true;
      }
      const body = parseJsonBody<{ name?: string }>(req) ?? {};
      const name = body.name?.trim() || assistant.name;
      const updatedAt = nowIso();
      db.query(
        "UPDATE assistants SET name = ?, updated_at = ? WHERE id = ?",
      ).run(name, updatedAt, assistant.id);
      sendJson(
        req,
        res,
        assistantPayload({ ...assistant, name, updated_at: updatedAt }, user),
      );
      return true;
    }
    if (req.method === "GET") {
      sendJson(req, res, assistantPayload(assistant, user));
      return true;
    }
  }

  return false;
}

function handleFeatureFlags(req: Request, res: Response): void {
  sendJson(req, res, {
    flags: {
      "worklin-retention": true,
      selfHostedChat: true,
      retentionAudit: true,
    },
  });
}

function handleBilling(
  req: Request,
  res: Response,
  url: URL,
  user: UserRow,
): boolean {
  const isCapabilityRequest = pathEquals(
    url.pathname,
    "/v1/organizations/billing/capability/",
  );
  const isBillingRequest = pathIsOrStartsWith(
    url.pathname,
    "/v1/organizations/billing/",
  );
  const isReferralRequest = pathEquals(
    url.pathname,
    "/v1/referral-codes/me/",
  );

  if (!isCapabilityRequest && !isBillingRequest && !isReferralRequest) {
    return false;
  }

  workspaceContext(req, user);

  if (isCapabilityRequest) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      sendJson(req, res, { detail: "Method not allowed." }, 405);
      return true;
    }
    sendJson(req, res, {
      available: false,
      mode: "external_provider",
      reason: "managed_billing_not_configured",
    });
    return true;
  }

  if (
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    !checkCsrf(req)
  ) {
    sendJson(req, res, { detail: "CSRF validation failed." }, 403);
    return true;
  }

  sendJson(
    req,
    res,
    {
      error: {
        code: "billing_unavailable",
        message: "Worklin credit billing is not available in this deployment.",
      },
    },
    501,
  );
  return true;
}

async function handleArtifactInvitations(
  req: Request,
  res: Response,
  url: URL,
  user: UserRow,
): Promise<boolean> {
  const createMatch =
    /^\/v1\/assistants\/([^/]+)\/artifact-invitations\/?$/.exec(url.pathname);
  if (createMatch && req.method === "POST") {
    if (!checkCsrf(req)) {
      sendJson(req, res, { detail: "CSRF validation failed." }, 403);
      return true;
    }
    const assistant = db
      .query<AssistantRow, [string, string]>(
        "SELECT * FROM assistants WHERE id = ? AND user_id = ?",
      )
      .get(createMatch[1]!, user.id);
    if (!assistant) {
      sendJson(req, res, { detail: "Assistant not found." }, 404);
      return true;
    }
    const body = parseJsonBody<{
      artifactId?: unknown;
      recipients?: Array<{ email?: unknown; role?: unknown }>;
    }>(req);
    const artifactId =
      typeof body?.artifactId === "string" ? body.artifactId.trim() : "";
    const recipients = Array.isArray(body?.recipients) ? body.recipients : [];
    if (!/^copybook:[^/]+$/.test(artifactId) || recipients.length === 0) {
      sendJson(
        req,
        res,
        {
          detail:
            "A Copybook artifact and at least one recipient are required.",
        },
        400,
      );
      return true;
    }
    if (!(await verifyShareableArtifact(assistant, user, artifactId))) {
      sendJson(
        req,
        res,
        { detail: "Artifact not found or not shareable." },
        404,
      );
      return true;
    }
    const expiresAt = nowSeconds() + 7 * 24 * 60 * 60;
    const invitations: Array<{
      email: string;
      role: string;
      inviteUrl: string;
      expiresAt: number;
    }> = [];
    for (const recipient of recipients) {
      const email =
        typeof recipient.email === "string"
          ? normalizeInviteEmail(recipient.email)
          : "";
      if (
        !/^\S+@\S+\.\S+$/.test(email) ||
        !isCollaborationRole(recipient.role) ||
        recipient.role === "owner"
      ) {
        sendJson(
          req,
          res,
          {
            detail:
              "Each recipient needs a valid email and Viewer, Commenter, or Editor role.",
          },
          400,
        );
        return true;
      }
      const token = randomToken();
      createArtifactInvitation(db, {
        assistant_id: assistant.id,
        artifact_id: artifactId,
        email_normalized: email,
        role: recipient.role,
        token_hash: invitationTokenHash(token),
        expires_at: expiresAt,
        created_by_user_id: user.id,
        created_at: nowIso(),
      });
      invitations.push({
        email,
        role: recipient.role,
        inviteUrl: inviteUrl(token),
        expiresAt,
      });
    }
    sendJson(req, res, { invitations }, 201);
    return true;
  }

  const acceptMatch = /^\/v1\/artifact-invitations\/([^/]+)\/accept\/?$/.exec(
    url.pathname,
  );
  if (acceptMatch && req.method === "POST") {
    if (!checkCsrf(req)) {
      sendJson(req, res, { detail: "CSRF validation failed." }, 403);
      return true;
    }
    const invitation = getActiveInvitationByTokenHash(
      db,
      invitationTokenHash(acceptMatch[1]!),
      nowSeconds(),
    );
    if (
      !invitation ||
      invitation.email_normalized !== normalizeInviteEmail(user.email)
    ) {
      sendJson(req, res, { detail: "Invitation not found." }, 404);
      return true;
    }
    const grant = acceptArtifactInvitation(db, invitation, user.id, nowIso());
    sendJson(req, res, {
      artifactId: grant.artifact_id,
      ownerAssistantId: grant.assistant_id,
      role: grant.role,
    });
    return true;
  }
  return false;
}

function copyProxyHeaders(req: Request): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value) continue;
    const normalized = key.toLowerCase();
    if (
      normalized === "host" ||
      normalized === "cookie" ||
      normalized === "content-length" ||
      normalized === "authorization" ||
      normalized === POOLED_MODEL_KEY_CAPABILITY_HEADER
    )
      continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

async function streamRuntimeResponse(
  req: Request,
  res: Response,
  response: globalThis.Response,
  signal?: AbortSignal,
): Promise<void> {
  applyRuntimeResponseHeaders(req, res, response);
  await pipeRuntimeResponseBody(res, response, signal);
}

function applyRuntimeResponseHeaders(
  req: Request,
  res: Response,
  response: globalThis.Response,
): void {
  res.status(response.status);
  setCorsHeaders(req, res);
  for (const [key, value] of response.headers) {
    const normalized = key.toLowerCase();
    if (
      normalized.startsWith("access-control-allow-") ||
      normalized === "content-length"
    )
      continue;
    res.setHeader(key, value);
  }
}

async function readBoundedRuntimeResponse(
  response: globalThis.Response,
  maxBytes = 128 * 1024,
): Promise<Buffer> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Runtime response exceeded the bounded proxy limit.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("Runtime response exceeded the bounded proxy limit.");
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function proxySharedArtifact(
  req: Request,
  res: Response,
  url: URL,
  user: UserRow,
): Promise<boolean> {
  if (
    pathEquals(url.pathname, "/v1/shared-artifacts/") &&
    req.method === "GET"
  ) {
    const grants = listActiveArtifactGrantsForRecipient(db, user.id);
    sendJson(req, res, {
      results: grants.map((grant) => ({
        artifactId: grant.artifact_id,
        ownerAssistantId: grant.assistant_id,
        role: grant.role,
        updatedAt: grant.updated_at,
      })),
    });
    return true;
  }

  const match =
    /^\/v1\/shared-artifacts\/([^/]+)(\/snapshot|\/months\/[^/]+\/(?:document|comments))\/?$/.exec(
      url.pathname,
    );
  if (!match) return false;
  const artifactId = decodeURIComponent(match[1]!);
  const suffix = match[2]!;
  const grant = getActiveArtifactGrantForRecipient(db, user.id, artifactId);
  if (!grant) {
    sendJson(req, res, { detail: "Shared artifact not found." }, 404);
    return true;
  }
  const assistant = db
    .query<AssistantRow, [string]>("SELECT * FROM assistants WHERE id = ?")
    .get(grant.assistant_id);
  if (!assistant) {
    sendJson(
      req,
      res,
      { detail: "Shared artifact is no longer available." },
      410,
    );
    return true;
  }
  const runtimeStack = ensureAssistantRuntime(assistant);
  if (!isRuntimeStackRoutable(runtimeStack)) {
    sendJson(req, res, runtimeNotReadyPayload(runtimeStack), 503);
    return true;
  }
  const tenantContext = createRuntimeTenantContext(
    assistant,
    user.id,
    runtimeStack,
  );
  const target = new URL(runtimeStack.gateway_url);
  target.pathname = `/v1/assistants/${encodeURIComponent(assistant.id)}/shared-artifacts/${encodeURIComponent(artifactId)}${suffix}`;
  target.search = url.search;
  const headers = copyProxyHeaders(req);
  headers.set(
    "Authorization",
    `Bearer ${mintActorToken(runtimeStack, tenantContext, {
      artifactId,
      role: grant.role,
    })}`,
  );
  applyRuntimeTenantHeaders(headers, tenantContext);
  const bodyBuffer =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(parseTextBody(req));
  const abortLifecycle = createRuntimeProxyAbortLifecycle(req, res);
  try {
    const response = await fetch(target, {
      method: req.method,
      headers,
      body: bodyBuffer ? new Uint8Array(bodyBuffer) : undefined,
      redirect: "manual",
      signal: abortLifecycle.controller.signal,
    });
    await streamRuntimeResponse(
      req,
      res,
      response,
      abortLifecycle.controller.signal,
    );
  } finally {
    abortLifecycle.cleanup();
  }
  return true;
}

function assistantIdFromProxyPath(pathname: string): string | null {
  const match = /^\/v1\/assistants\/([^/]+)\//.exec(pathname);
  return match?.[1] ?? null;
}

async function proxyLiveVoiceProviderCallback(
  req: Request,
  res: Response,
  url: URL,
): Promise<void> {
  const sessionToken = url.searchParams.get("custom_session_id") ?? "";
  const routingHint = managedVoiceRoutingHintFromToken(sessionToken);
  if (!routingHint) {
    sendJson(req, res, { error: { message: "Invalid voice session" } }, 401);
    return;
  }

  const assistant = db
    .query<AssistantRow, [string]>("SELECT * FROM assistants WHERE id = ?")
    .get(routingHint.assistantId);
  if (!assistant) {
    sendJson(req, res, { error: { message: "Invalid voice session" } }, 401);
    return;
  }

  const runtimeStack = ensureAssistantRuntime(assistant);
  const routingPolicy = selectRuntimeWorkerRoutingPolicy(
    runtimeStack,
    runtimeWorkerCoordinator.config,
    Date.now(),
  );
  if (routingPolicy.mode === "unavailable") {
    sendJson(
      req,
      res,
      { error: { message: "Worklin voice is temporarily unavailable" } },
      503,
    );
    return;
  }

  const tenantContext = createRuntimeTenantContext(
    assistant,
    assistant.user_id,
    runtimeStack,
  );
  const pooledIdentity = {
    organizationId: tenantContext.organizationId,
    userId: tenantContext.userId,
    assistantId: tenantContext.assistantId,
    actorId: tenantContext.actorId,
  };

  let gatewayUrl: string;
  let pooledRequestHandle: string | null = null;
  let pooledGatewayIngressToken: string | null = null;
  let pooledLeaseBinding: RuntimeWorkerLeaseServiceBinding | null = null;
  if (routingPolicy.mode === "dedicated") {
    gatewayUrl = routingPolicy.stack.gateway_url!;
  } else {
    if (
      !runtimeWorkerSessionLeases.hasLiveVoiceSession(
        routingHint.sessionId,
        pooledIdentity,
      )
    ) {
      sendJson(req, res, { error: { message: "Invalid voice session" } }, 401);
      return;
    }
    const route = await runtimeWorkerCoordinator.routeRequest({
      identity: pooledIdentity,
      dedicatedRoute: {
        gatewayUrl: "https://invalid.invalid",
        actorToken: "invalid",
      },
    });
    if (route.mode !== "pooled") {
      sendJson(
        req,
        res,
        { error: { message: "Worklin voice is temporarily unavailable" } },
        503,
      );
      return;
    }
    gatewayUrl = route.gatewayUrl;
    pooledRequestHandle = route.requestHandle;
    pooledGatewayIngressToken = route.gatewayIngressToken;
    pooledLeaseBinding = route.binding;
  }

  const target = new URL(gatewayUrl);
  target.pathname = "/v1/live-voice/providers/chat/completions";
  target.search = url.search;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value) continue;
    const normalized = key.toLowerCase();
    if (
      normalized === "host" ||
      normalized === "cookie" ||
      normalized === "content-length" ||
      normalized === POOLED_MODEL_KEY_CAPABILITY_HEADER
    )
      continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  if (pooledGatewayIngressToken) {
    headers.set(
      "X-Worklin-Runtime-Authorization",
      `Bearer ${pooledGatewayIngressToken}`,
    );
  }

  const body = Buffer.isBuffer(req.body)
    ? new Uint8Array(req.body)
    : new Uint8Array(Buffer.from(parseTextBody(req)));
  const abortLifecycle = createRuntimeProxyAbortLifecycle(req, res);
  let unregisterPooledAbort: (() => void) | null = null;
  try {
    if (pooledRequestHandle && pooledLeaseBinding) {
      unregisterPooledAbort = runtimeWorkerRequestAbortRegistry.register(
        abortLifecycle.controller,
      );
      headers.delete("x-vellum-proxy-server");
      try {
        headers.set(
          POOLED_MODEL_KEY_CAPABILITY_HEADER,
          mintPooledModelKeyRequestCapability(
            pooledIdentity,
            pooledLeaseBinding,
            pooledRequestHandle,
            Date.now(),
          ),
        );
      } catch (error) {
        if (!(error instanceof RuntimeWorkerCoordinatorOwnershipLostError)) {
          throw error;
        }
        sendJson(
          req,
          res,
          { error: { message: "Worklin voice is temporarily unavailable" } },
          503,
        );
        return;
      }
    }
    const response = await fetch(target, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: abortLifecycle.controller.signal,
    });
    await streamRuntimeResponse(
      req,
      res,
      response,
      abortLifecycle.controller.signal,
    );
  } finally {
    unregisterPooledAbort?.();
    abortLifecycle.cleanup();
    if (pooledRequestHandle) {
      pooledModelKeyVault.revokeRequestCapability(pooledRequestHandle);
      await finishPooledRuntimeRequest(pooledRequestHandle, pooledIdentity);
    }
  }
}

async function proxyToGateway(
  req: Request,
  res: Response,
  url: URL,
  user: UserRow,
): Promise<void> {
  const assistantId = assistantIdFromProxyPath(url.pathname);
  if (!assistantId) {
    sendJson(req, res, { detail: "Assistant not found." }, 404);
    return;
  }

  const assistant = accessibleAssistantsForUser(req, user).find(
    (candidate) => candidate.id === assistantId,
  );
  if (!assistant) {
    sendJson(req, res, { detail: "Assistant not found." }, 404);
    return;
  }

  if (!hasAcceptedAssistantConsent(user.consent_json)) {
    sendJson(
      req,
      res,
      { detail: "Assistant consent must be accepted before use." },
      403,
    );
    return;
  }

  // This is the first real assistant request. Only here do we claim the
  // stack and start lazy provisioning; list, consent, and hatch calls remain
  // read-only with respect to Railway capacity.
  const runtimeStack = ensureAssistantRuntime(assistant);
  const routingPolicy = selectRuntimeWorkerRoutingPolicy(
    runtimeStack,
    runtimeWorkerCoordinator.config,
    Date.now(),
  );
  if (routingPolicy.mode === "unavailable") {
    console.warn("proxy_missing_active_runtime_stack", {
      assistantId: assistant.id,
      userId: user.id,
      runtimeStackId: runtimeStack.id,
      runtimeStatus: runtimeStack.status,
      routingReason: routingPolicy.reason,
    });
    sendJson(req, res, runtimeNotReadyPayload(runtimeStack), 503);
    return;
  }

  let pooledRouteDecision: RuntimeWorkerProxyRouteDecision | null = null;
  if (routingPolicy.mode === "pooled") {
    pooledRouteDecision = classifyRuntimeWorkerProxyRoute({
      method: req.method,
      pathname: url.pathname,
      upgrade: req.headers.upgrade,
    });
    if (pooledRouteDecision.status === "rejected") {
      sendPooledRuntimeRouteRejection(req, res, pooledRouteDecision.reason);
      return;
    }
  }

  let tenantContext: RuntimeTenantContext;
  try {
    tenantContext = createRuntimeTenantContext(
      assistant,
      user.id,
      runtimeStack,
    );
  } catch (error) {
    if (!(error instanceof RuntimeTenantContextError)) throw error;
    console.error("runtime_tenant_context_rejected", {
      assistantId: assistant.id,
      userId: user.id,
      runtimeStackId: runtimeStack.id,
      reason: error.message,
    });
    sendJson(
      req,
      res,
      {
        detail: "Assistant runtime identity is unavailable.",
        code: "runtime_tenant_context_invalid",
      },
      503,
    );
    return;
  }

  const pooledIdentity = {
    organizationId: tenantContext.organizationId,
    userId: tenantContext.userId,
    assistantId: tenantContext.assistantId,
    actorId: tenantContext.actorId,
  };
  if (
    pooledRouteDecision?.status === "allowed" &&
    pooledRouteDecision.handling === "control_plane_model_key_vault"
  ) {
    if ((req.method === "POST" || req.method === "DELETE") && !checkCsrf(req)) {
      sendJson(req, res, { detail: "CSRF validation failed." }, 403);
      return;
    }
    const secretInput = {
      method: req.method,
      routeSegments: pooledRouteDecision.routeSegments,
      tenant: pooledIdentity,
      body: parseJsonBody<unknown>(req),
    };
    const isRootSecretMutation =
      (req.method === "POST" || req.method === "DELETE") &&
      pooledRouteDecision.routeSegments.length === 1 &&
      pooledRouteDecision.routeSegments[0] === "secrets";
    if (isRootSecretMutation) {
      const mutation =
        await runtimeWorkerCoordinator.runTenantConfigurationMutation({
          identity: pooledIdentity,
          mutation: () => pooledModelKeyVault.handleSecretRoute(secretInput),
        });
      if (mutation.status === "rejected") {
        sendJson(
          req,
          res,
          {
            detail:
              "Model provider settings cannot change while this assistant is handling a request.",
            code: "pooled_runtime_model_provider_configuration_busy",
          },
          409,
        );
        return;
      }
      if (mutation.status === "unavailable") {
        sendJson(
          req,
          res,
          {
            detail: "Model provider settings are temporarily unavailable.",
            code: "pooled_runtime_model_provider_configuration_unavailable",
          },
          503,
        );
        return;
      }
      sendJson(req, res, mutation.value.body, mutation.value.status);
      return;
    }
    const result = await pooledModelKeyVault.handleSecretRoute(secretInput);
    sendJson(req, res, result.body, result.status);
    return;
  }
  if (
    pooledRouteDecision?.status === "allowed" &&
    (pooledRouteDecision.handling === "release_live_voice_session" ||
      pooledRouteDecision.handling === "use_held_live_voice_session") &&
    !runtimeWorkerSessionLeases.hasLiveVoiceSession(
      pooledRouteDecision.sessionId,
      pooledIdentity,
    )
  ) {
    sendJson(
      req,
      res,
      {
        detail: "This voice session is no longer active.",
        code: "pooled_voice_session_not_active",
      },
      409,
    );
    return;
  }

  const admissionIdentity = {
    organizationId: assistant.org_id,
    userId: tenantContext.userId,
    assistantId: assistant.id,
  };
  const requestKind = classifyTenantRuntimeRequest(req.method, url.pathname);
  const usageEventPrefix = randomUUID();
  const requestStartedAt = Date.now();
  const admission = acquireTenantRuntimeAdmission(
    db,
    tenantRuntimeAdmissionConfig,
    admissionIdentity,
    requestKind,
    randomUUID(),
    requestStartedAt,
    nowIso,
  );
  if (admission.status === "rejected") {
    sendTenantRuntimeAdmissionRejection(req, res, admission);
    return;
  }
  recordProxyRuntimeUsage(
    admissionIdentity,
    `${usageEventPrefix}:request`,
    "request_count",
    1,
    requestStartedAt,
  );
  if (requestKind.requestClass === "turn") {
    recordProxyRuntimeUsage(
      admissionIdentity,
      `${usageEventPrefix}:turn`,
      "turn_count",
      1,
      requestStartedAt,
    );
  }

  const bodyBuffer =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(parseTextBody(req));
  const body = bodyBuffer ? new Uint8Array(bodyBuffer) : undefined;

  const abortLifecycle = createRuntimeProxyAbortLifecycle(req, res);
  const { controller: abortController } = abortLifecycle;
  let unregisterPooledAbort: (() => void) | null = null;
  const heartbeat =
    admission.status === "admitted"
      ? setInterval(
          () => {
            const result = renewTenantRuntimeAdmission(
              db,
              tenantRuntimeAdmissionConfig,
              admissionIdentity,
              admission.token,
              Date.now(),
            );
            if (result.status !== "updated") abortController.abort();
          },
          Math.max(
            1_000,
            Math.floor(tenantRuntimeAdmissionConfig.admissionTtlMs / 3),
          ),
        )
      : null;
  heartbeat?.unref();

  let pooledRequestHandle: string | null = null;
  let pooledLeaseBinding: RuntimeWorkerLeaseServiceBinding | null = null;
  let retainPooledRequest = false;
  try {
    let gatewayUrl: string;
    let actorToken: string;
    if (routingPolicy.mode === "dedicated") {
      gatewayUrl = routingPolicy.stack.gateway_url!;
      actorToken = mintActorToken(routingPolicy.stack, tenantContext);
    } else {
      const route = await runtimeWorkerCoordinator.routeRequest({
        identity: pooledIdentity,
        dedicatedRoute: {
          gatewayUrl: "https://invalid.invalid",
          actorToken: "invalid",
        },
      });
      if (route.mode !== "pooled") {
        if (route.mode === "unavailable" && route.retryAfterMs !== null) {
          res.setHeader(
            "Retry-After",
            String(Math.max(1, Math.ceil(route.retryAfterMs / 1_000))),
          );
        }
        sendJson(
          req,
          res,
          {
            detail: "All assistant workers are busy. Please retry shortly.",
            code:
              route.mode === "unavailable"
                ? `pooled_runtime_${route.reason}`
                : "pooled_runtime_route_mismatch",
          },
          route.mode === "unavailable" &&
            (route.reason === "capacity_exhausted" ||
              route.reason === "assistant_busy")
            ? 429
            : 503,
        );
        return;
      }
      gatewayUrl = route.gatewayUrl;
      actorToken = route.actorToken;
      pooledRequestHandle = route.requestHandle;
      pooledLeaseBinding = route.binding;
      unregisterPooledAbort = runtimeWorkerRequestAbortRegistry.register(
        abortController,
      );
    }

    if (routingPolicy.mode === "pooled") {
      const storageGuard = guardTenantStorageOperation(
        db,
        tenantRuntimeOperationsConfig,
        admissionIdentity,
        req.method === "DELETE"
          ? { effect: "non_increasing" }
          : req.method === "POST" ||
              req.method === "PATCH" ||
              req.method === "PUT"
            ? {
                effect: "may_increase",
                reservationToken: randomUUID(),
                requestedBytes: Math.max(
                  bodyBuffer?.byteLength ?? 0,
                  TENANT_MUTATION_RESERVATION_FLOOR_BYTES,
                ),
              }
            : { effect: "non_increasing" },
        Date.now(),
      );
      if (storageGuard.status === "rejected") {
        sendTenantStorageGuardRejection(req, res, storageGuard);
        return;
      }
    }

    const target = new URL(gatewayUrl);
    target.pathname = url.pathname;
    target.search = url.search;

    const headers = copyProxyHeaders(req);
    headers.set("Authorization", `Bearer ${actorToken}`);
    applyRuntimeTenantHeaders(headers, tenantContext);
    if (pooledRequestHandle && pooledLeaseBinding) {
      // The gateway IPC fast path forwards only public Vellum headers. Pooled
      // model-key capabilities stay on the private HTTP hop and are never
      // copied from a renderer request.
      headers.delete("x-vellum-proxy-server");
      try {
        headers.set(
          POOLED_MODEL_KEY_CAPABILITY_HEADER,
          mintPooledModelKeyRequestCapability(
            pooledIdentity,
            pooledLeaseBinding,
            pooledRequestHandle,
            Date.now(),
          ),
        );
      } catch (error) {
        if (!(error instanceof RuntimeWorkerCoordinatorOwnershipLostError)) {
          throw error;
        }
        sendJson(
          req,
          res,
          {
            detail: "Assistant workers are temporarily unavailable.",
            code: "pooled_runtime_coordinator_ownership_lost",
          },
          503,
        );
        return;
      }
    }

    const response = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
      signal: abortController.signal,
    });

    if (
      routingPolicy.mode === "pooled" &&
      pooledRouteDecision?.status === "allowed" &&
      pooledRouteDecision.handling === "hold_live_voice_session" &&
      response.ok &&
      pooledRequestHandle
    ) {
      const buffered = await readBoundedRuntimeResponse(response);
      const bootstrap = parseManagedPooledVoiceBootstrap(buffered);
      const held = bootstrap
        ? runtimeWorkerSessionLeases.holdLiveVoiceSession({
            sessionId: bootstrap.sessionId,
            requestHandle: pooledRequestHandle,
            identity: pooledIdentity,
            expiresAtMs: bootstrap.expiresAtMs,
          })
        : null;
      if (!bootstrap || held?.status !== "held") {
        sendJson(
          req,
          res,
          {
            detail: "Managed voice could not retain a safe worker session.",
            code: "pooled_voice_session_hold_failed",
          },
          503,
        );
        return;
      }
      retainPooledRequest = true;
      applyRuntimeResponseHeaders(req, res, response);
      res.end(buffered);
      return;
    }
    await streamRuntimeResponse(req, res, response, abortController.signal);
  } finally {
    if (pooledRequestHandle) {
      pooledModelKeyVault.revokeRequestCapability(pooledRequestHandle);
      if (!retainPooledRequest) {
        await finishPooledRuntimeRequest(pooledRequestHandle, pooledIdentity);
      }
    }
    if (
      pooledRouteDecision?.status === "allowed" &&
      pooledRouteDecision.handling === "release_live_voice_session"
    ) {
      await runtimeWorkerSessionLeases.releaseLiveVoiceSession({
        sessionId: pooledRouteDecision.sessionId,
        identity: pooledIdentity,
      });
    }
    const completedAt = Date.now();
    const elapsedMs = Math.max(1, completedAt - requestStartedAt);
    recordProxyRuntimeUsage(
      admissionIdentity,
      `${usageEventPrefix}:worker`,
      "worker_ms",
      elapsedMs,
      completedAt,
    );
    if (requestKind.requestClass === "stream") {
      recordProxyRuntimeUsage(
        admissionIdentity,
        `${usageEventPrefix}:stream`,
        "stream_ms",
        elapsedMs,
        completedAt,
      );
    }
    unregisterPooledAbort?.();
    abortLifecycle.cleanup();
    if (heartbeat) clearInterval(heartbeat);
    if (admission.status === "admitted") {
      releaseTenantRuntimeAdmission(
        db,
        tenantRuntimeAdmissionConfig,
        admissionIdentity,
        admission.token,
        Date.now(),
      );
    }
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}

function parseManagedPooledVoiceBootstrap(buffered: Buffer): {
  sessionId: string;
  expiresAtMs: number;
} | null {
  let value: unknown;
  try {
    value = JSON.parse(buffered.toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return parseManagedPooledVoiceSessionBootstrap(record);
}

async function finishPooledRuntimeRequest(
  requestHandle: string,
  identity: {
    organizationId: string;
    userId: string;
    assistantId: string;
    actorId: string;
  },
): Promise<void> {
  try {
    const result = await runtimeWorkerCoordinator.finishRequest({
      requestHandle,
      identity,
    });
    if (
      result.status === "unknown_request" ||
      result.status === "route_handle_mismatch" ||
      result.status === "release_failed"
    ) {
      console.error("pooled_runtime_request_release_failed", {
        status: result.status,
      });
    }
  } catch {
    console.error("pooled_runtime_request_release_failed", {
      status: "exception",
    });
  }
}

function sendPooledRuntimeRouteRejection(
  req: Request,
  res: Response,
  reason: Extract<
    RuntimeWorkerProxyRouteDecision,
    { status: "rejected" }
  >["reason"],
): void {
  const malformed =
    reason === "malformed_path" || reason === "unsupported_http_method";
  sendJson(
    req,
    res,
    {
      detail: malformed
        ? "This assistant request is invalid."
        : "This feature currently requires a dedicated assistant runtime.",
      code: `pooled_runtime_${reason}`,
    },
    malformed ? 400 : 409,
  );
}

function recordProxyRuntimeUsage(
  identity: {
    organizationId: string;
    userId: string;
    assistantId: string;
  },
  eventId: string,
  metric: TenantRuntimeUsageMetric,
  value: number,
  observedAtMs: number,
): void {
  try {
    const result = recordTenantRuntimeUsage(
      db,
      tenantRuntimeOperationsConfig,
      identity,
      { eventId, metric, value, observedAtMs },
      nowIso,
    );
    if (result.status === "rejected") {
      console.error("tenant_runtime_usage_rejected", {
        reason: result.reason,
        metric,
      });
    }
  } catch (error) {
    console.error("tenant_runtime_usage_recording_failed", {
      metric,
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}

function sendTenantStorageGuardRejection(
  req: Request,
  res: Response,
  rejection: Extract<TenantStorageGuardResult, { status: "rejected" }>,
): void {
  const quotaExceeded = rejection.reason === "storage_quota_exceeded";
  if (rejection.retryAfterMs !== null) {
    res.setHeader(
      "Retry-After",
      String(Math.max(1, Math.ceil(rejection.retryAfterMs / 1_000))),
    );
  }
  sendJson(
    req,
    res,
    {
      detail: quotaExceeded
        ? "This assistant has reached its workspace storage limit."
        : "Workspace storage is being verified. Please retry shortly.",
      code: `tenant_runtime_${rejection.reason}`,
    },
    quotaExceeded ? 413 : rejection.reason === "invalid_tenant" ? 403 : 503,
  );
}

function sendTenantRuntimeAdmissionRejection(
  req: Request,
  res: Response,
  rejection: Extract<TenantRuntimeAdmissionResult, { status: "rejected" }>,
): void {
  const overloaded =
    rejection.reason === "rate_limited" ||
    rejection.reason === "request_concurrency_exhausted" ||
    rejection.reason === "turn_concurrency_exhausted";
  if (rejection.retryAfterMs !== null) {
    res.setHeader(
      "Retry-After",
      String(Math.max(1, Math.ceil(rejection.retryAfterMs / 1_000))),
    );
  }
  sendJson(
    req,
    res,
    {
      detail: overloaded
        ? "This assistant is busy. Please retry shortly."
        : "This assistant is temporarily unavailable.",
      code: `tenant_runtime_${rejection.reason}`,
    },
    overloaded ? 429 : rejection.reason === "invalid_tenant" ? 403 : 503,
  );
}

function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

const app = express();
app.set("trust proxy", true);
app.use(corsMiddleware);
app.use("/logout", (req, res, next) => {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  try {
    if (sessionId) {
      db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
    }
  } catch (error) {
    console.error("worklin_logout_session_cleanup_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    appendCookie(res, clearCookie(SESSION_COOKIE));
    next();
  }
});

if (auth0Configured()) {
  app.use(
    auth({
      authRequired: false,
      auth0Logout: true,
      secret: env.auth0Secret,
      baseURL: env.auth0BaseUrl,
      clientID: env.auth0ClientId,
      clientSecret: env.auth0ClientSecret,
      issuerBaseURL: env.auth0IssuerBaseUrl,
      clientAuthMethod: "client_secret_post",
      authorizationParams: {
        response_type: "code",
        scope: "openid profile email",
      },
      routes: {
        callback: "/callback",
        postLogoutRedirect: publicWebOrigin() + "/account/login",
      },
      session: {
        name: AUTH0_SESSION_COOKIE,
        cookie: {
          secure: useSecureCookies,
          sameSite: cookieSameSite,
        },
      },
      transactionCookie: {
        sameSite: cookieSameSite,
      },
      afterCallback: async (req, res, session) => {
        const user = upsertAuth0User(session as Auth0Claims);
        ensureUserSessionCookie(req, res, user);
        return session;
      },
    }),
  );
} else {
  console.warn("Auth0 is not configured; login routes will return 503.");
}

app.post(
  "/_allauth/browser/v1/auth/provider/redirect",
  express.urlencoded({ extended: false }),
  asyncHandler(handleProviderRedirect),
);

app.use(express.raw({ type: "*/*", limit: "50mb" }));

app.get(
  RUNTIME_WORKER_OPERATOR_RECOVERY_PATH,
  asyncHandler(async (req, res) => {
    if (!runtimeWorkerOperatorRecoveryConfig.enabled) {
      sendJson(req, res, { detail: "Not found." }, 404);
      return;
    }
    if (
      !authorizeRuntimeWorkerOperatorRecovery(
        runtimeWorkerOperatorRecoveryConfig,
        req.headers.authorization,
      )
    ) {
      sendJson(req, res, { detail: "Invalid operator authorization." }, 401);
      return;
    }
    sendJson(req, res, {
      candidates: runtimeWorkerCoordinator.listOperatorRecoveryCandidates(),
    });
  }),
);

app.post(
  RUNTIME_WORKER_OPERATOR_RECOVERY_PATH,
  asyncHandler(async (req, res) => {
    if (!runtimeWorkerOperatorRecoveryConfig.enabled) {
      sendJson(req, res, { detail: "Not found." }, 404);
      return;
    }
    if (
      !authorizeRuntimeWorkerOperatorRecovery(
        runtimeWorkerOperatorRecoveryConfig,
        req.headers.authorization,
      )
    ) {
      sendJson(req, res, { detail: "Invalid operator authorization." }, 401);
      return;
    }
    const recovery = parseRuntimeWorkerOperatorRecoveryRequest(
      parseJsonBody<unknown>(req),
    );
    if (!recovery) {
      sendJson(req, res, { detail: "Invalid recovery request." }, 400);
      return;
    }

    const result =
      recovery.action === "release_restart_lease"
        ? await runtimeWorkerCoordinator.recoverRestartQuarantine({
            binding: recovery.binding,
          })
        : await runtimeWorkerCoordinator.discardQuarantinedState({
            binding: recovery.binding,
          });
    const status =
      result.status === "recovered" || result.status === "not_quarantined"
        ? 200
        : result.status === "recovery_failed"
          ? 503
          : 409;
    sendJson(req, res, { result }, status);
  }),
);

app.post(
  POOLED_MODEL_KEY_RESOLVE_PATH,
  asyncHandler(async (req, res) => {
    if (!pooledCoordinatorOwnershipIsLive()) {
      sendJson(req, res, { detail: "Model key service unavailable." }, 503);
      return;
    }
    const authorization = req.headers.authorization ?? "";
    const match =
      /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u.exec(
        authorization,
      );
    const body = parseJsonBody<{ provider?: unknown }>(req);
    const result = pooledModelKeyVault.resolveWithCapability(
      match?.[1] ?? "",
      body?.provider,
      Date.now(),
    );
    if (!result.ok) {
      if (result.reason === "disabled") {
        sendJson(req, res, { detail: "Model key service unavailable." }, 503);
        return;
      }
      if (result.reason === "invalid_provider") {
        sendJson(req, res, { detail: "Invalid model provider." }, 400);
        return;
      }
      sendJson(req, res, { detail: "Invalid model key capability." }, 401);
      return;
    }
    if (result.value === null) {
      sendJson(req, res, { detail: "Model provider key not found." }, 404);
      return;
    }
    if (!pooledCoordinatorOwnershipIsLive()) {
      sendJson(req, res, { detail: "Model key service unavailable." }, 503);
      return;
    }
    sendJson(req, res, { value: result.value });
  }),
);

app.get("/healthz", (req, res) =>
  sendJson(req, res, { ok: true, release_sha: RELEASE_SHA }),
);
app.get(
  "/readyz",
  asyncHandler(async (req, res) => {
    if (env.runtimeMode === "control-plane") {
      const configurationError = controlPlaneOnlyConfigurationError();
      sendJson(
        req,
        res,
        {
          ok: configurationError === null,
          gatewayStatus: null,
          runtimeMode: env.runtimeMode,
          provisionerReady: configurationError === null,
          ...(pooledCoordinatorOwnershipIsLive()
            ? { pooledRuntimeWorkers: runtimeWorkerStartup }
            : {}),
        },
        configurationError === null ? 200 : 503,
      );
      return;
    }
    try {
      const gateway = await fetch(`${env.gatewayUrl}/readyz`);
      sendJson(
        req,
        res,
        {
          ok: gateway.ok,
          gatewayStatus: gateway.status,
          ...(pooledCoordinatorOwnershipIsLive()
            ? { pooledRuntimeWorkers: runtimeWorkerStartup }
            : {}),
        },
        gateway.ok ? 200 : 503,
      );
    } catch {
      sendJson(
        req,
        res,
        {
          ok: false,
          gatewayStatus: null,
          ...(pooledCoordinatorOwnershipIsLive()
            ? { pooledRuntimeWorkers: runtimeWorkerStartup }
            : {}),
        },
        503,
      );
    }
  }),
);
app.get("/_allauth/browser/v1/auth/session", asyncHandler(handleSession));
app.delete("/_allauth/browser/v1/auth/session", asyncHandler(handleSession));
app.get("/_allauth/browser/v1/config", (req, res) =>
  sendJson(req, res, authConfigPayload()),
);

app.use(
  asyncHandler(async (req, res) => {
    const url = new URL(req.originalUrl, env.apiOrigin);

    if (pathEquals(url.pathname, "/v1/feature-flags/client-flag-values/")) {
      handleFeatureFlags(req, res);
      return;
    }
    if (
      pathEquals(url.pathname, "/v1/telemetry/ingest/") &&
      req.method === "POST"
    ) {
      sendJson(req, res, { ok: true }, 202);
      return;
    }

    if (
      url.pathname === "/v1/live-voice/providers/chat/completions" &&
      req.method === "POST"
    ) {
      await proxyLiveVoiceProviderCallback(req, res, url);
      return;
    }

    const user = requireUser(req, res);
    if (!user) return;

    try {
      if (await handleWorkspace(req, res, url, user)) return;

      if (pathEquals(url.pathname, "/v1/user/me/")) {
        await handleUserMe(req, res, user);
        return;
      }
      if (pathEquals(url.pathname, "/v1/organizations/")) {
        handleOrganizations(req, res, user);
        return;
      }
      if (await handleBrandResearchRuns(req, res, url, user)) return;
      if (handleBilling(req, res, url, user)) return;

      if (await handleArtifactInvitations(req, res, url, user)) return;
      if (await proxySharedArtifact(req, res, url, user)) return;

      if (pathIsOrStartsWith(url.pathname, "/v1/assistants/")) {
        const handled = await handleAssistants(req, res, url, user);
        if (handled) return;
        await proxyToGateway(req, res, url, user);
        return;
      }

      sendJson(req, res, { detail: "Not found." }, 404);
    } catch (error) {
      if (error instanceof WorkspaceAccessError) {
        sendJson(req, res, { detail: error.message }, 403);
        return;
      }
      throw error;
    }
  }),
);

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  if (!res.headersSent) {
    sendJson(req, res, { detail: "Internal server error." }, 500);
  }
});

const server = app.listen(env.port, env.host, () => {
  console.log(`Worklin control plane listening on ${env.host}:${env.port}`);
});

const runtimeProvisionerError = runtimeProvisioningConfigurationError();
if (runtimeProvisionerError) {
  console.warn("runtime_stack_provisioner_unavailable", {
    reason: runtimeProvisionerError,
  });
}
resumeRuntimeProvisioning();

let runtimeWorkerHealthMonitor: ReturnType<typeof setInterval> | null = null;
let runtimeWorkerHealthProbeInFlight = false;
if (
  runtimeWorkerStartup.status === "active" &&
  runtimeWorkerCoordinatorOwnership
) {
  runtimeWorkerCoordinatorHeartbeat = setInterval(() => {
    const renewed = runtimeWorkerCoordinatorOwnership.renew(
      runtimeWorkerCoordinatorOwnershipConfig.ownershipTtlMs,
      nowIso,
    );
    if (renewed.status === "lost") {
      void fencePooledRuntimeCoordinator(
        new RuntimeWorkerCoordinatorOwnershipLostError(
          "Pooled runtime coordinator ownership was lost.",
        ),
      ).catch(() => {
        console.error("runtime_worker_coordinator_fence_failed");
      });
    }
  }, runtimeWorkerCoordinatorOwnershipConfig.heartbeatMs);
  runtimeWorkerCoordinatorHeartbeat.unref();
}
if (runtimeWorkerStartup.status === "active") {
  runtimeWorkerHealthMonitor = setInterval(() => {
    if (runtimeWorkerHealthProbeInFlight) return;
    runtimeWorkerHealthProbeInFlight = true;
    void activatePooledRuntimeWorkersAtStartup(db, process.env, {
      nowIso,
      ...(runtimeWorkerCoordinatorOwnership
        ? { coordinatorOwnership: runtimeWorkerCoordinatorOwnership }
        : {}),
    })
      .catch(() => {
        console.error("runtime_worker_health_probe_failed");
      })
      .finally(() => {
        runtimeWorkerHealthProbeInFlight = false;
      });
  }, 30_000);
  runtimeWorkerHealthMonitor.unref();
}

function observeRuntimeWorkerCapacity(): void {
  try {
    const result = persistRuntimeCapacityAlert(
      db,
      tenantRuntimeOperationsConfig,
      getRuntimeWorkerCapacityTelemetry(
        db,
        runtimeWorkerPoolConfig,
        Date.now(),
      ),
      Date.now(),
      nowIso,
    );
    if (result.status === "alert" && result.persisted) {
      console.warn("runtime_worker_capacity_alert", result.alert);
    }
  } catch (error) {
    console.error("runtime_worker_capacity_observation_failed", {
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}

let runtimeCapacityMonitor: ReturnType<typeof setInterval> | null = null;
if (
  tenantRuntimeOperationsConfig.enabled &&
  tenantRuntimeOperationsConfig.capacityAlertsEnabled
) {
  observeRuntimeWorkerCapacity();
  runtimeCapacityMonitor = setInterval(
    observeRuntimeWorkerCapacity,
    Math.min(60_000, tenantRuntimeOperationsConfig.capacityAlertDedupWindowMs),
  );
  runtimeCapacityMonitor.unref();
}

// Bun's Node HTTP compatibility can let an Express-only process exit after
// listen() unless another handle is active. Keep the control-plane alive in
// local and container runtimes.
const keepAlive = setInterval(() => {}, 2 ** 31 - 1);
let shutdownStarted = false;
const closeForShutdown = () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  server.close();
};
process.once("SIGTERM", closeForShutdown);
process.once("SIGINT", closeForShutdown);
server.on("close", () => {
  clearInterval(keepAlive);
  if (runtimeWorkerHealthMonitor) clearInterval(runtimeWorkerHealthMonitor);
  if (runtimeCapacityMonitor) clearInterval(runtimeCapacityMonitor);
  if (runtimeWorkerCoordinatorHeartbeat) {
    clearInterval(runtimeWorkerCoordinatorHeartbeat);
    runtimeWorkerCoordinatorHeartbeat = null;
  }
  runtimeWorkerRequestAbortRegistry.abortAll(
    new Error("Control plane is shutting down."),
  );
  pooledModelKeyVault.revokeAllRequestCapabilities();
  void runtimeWorkerCoordinator.fenceCoordinatorOwnership().catch(() => {
    console.error("runtime_worker_coordinator_fence_failed");
  });
  const released = runtimeWorkerCoordinatorOwnership?.release(nowIso);
  if (released?.status === "lost" && !runtimeWorkerCoordinatorFenced) {
    console.error("runtime_worker_coordinator_release_failed");
  }
});
