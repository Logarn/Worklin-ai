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
import { assistantIdFromManagedVoiceRoutingToken } from "./live-voice-provider-callback.js";
import {
  ensureAssistantStoreSchema,
  getActiveAssistant as getStoredActiveAssistant,
  getOrCreateAssistant as getOrCreateStoredAssistant,
  getOrCreateOrganization as getOrCreateStoredOrganization,
  hasAcceptedAssistantConsent,
  type AssistantRow,
  type OrganizationRow,
} from "./assistant-store.js";
import {
  BoundedKeyedTaskScheduler,
  provisionRailwayRuntime,
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
  applyRuntimeTenantHeaders,
  createRuntimeTenantContext,
  getOwnedAssistantForRuntime,
  RuntimeTenantContextError,
  runtimeTenantContextClaim,
  type RuntimeTenantContext,
} from "./runtime-tenant-context.js";

const SESSION_COOKIE = "worklin_session";
const SECURE_CSRF_COOKIE = "__Secure-csrftoken";
const LOCAL_CSRF_COOKIE = "csrftoken";
const AUTH0_SESSION_COOKIE = "worklin_auth0_session";
const CANONICAL_VERCEL_WEB_ORIGIN = "https://worklin-ai.vercel.app";
const LEGACY_VERCEL_WEB_ORIGIN = "https://ai-retention-marketer.vercel.app";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const ACTOR_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const POLICY_EPOCH = 1;

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

function getActiveAssistant(user: UserRow): AssistantRow | null {
  return getStoredActiveAssistant(db, user.id);
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

function assistantPayload(
  row: AssistantRow,
  user: UserRow,
  runtimeStack = runtimeStackForPayload(row),
) {
  const tenantContext = createRuntimeTenantContext(row, user.id, runtimeStack);
  return {
    id: row.id,
    name: row.name,
    handle: "worklin",
    description: "Worklin autonomous retention marketing assistant",
    configuration: {},
    status: assistantApiStatusForRuntimeStack(runtimeStack),
    runtime_status: runtimeStack.status,
    runtime_stack_id: runtimeStack.id,
    runtime_provider: runtimeStack.provider,
    runtime_last_health_status: runtimeStack.last_health_status,
    runtime_last_error: runtimeStack.last_error,
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
    ingress_url: publicWebOrigin(),
    platform_actor_token: mintActorToken(runtimeStack, tenantContext),
    access_consented: hasAcceptedAssistantConsent(user.consent_json),
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
  const provisioningError = runtimeProvisioningConfigurationError();
  if (provisioningError) return provisioningError;
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
    .query<
      { consent_json: string | null },
      [string]
    >("SELECT consent_json FROM users WHERE id = ?")
    .get(assistant.user_id);
  return hasAcceptedAssistantConsent(owner?.consent_json ?? null);
}

function ensureAssistantRuntime(assistant: AssistantRow): RuntimeStackRow {
  const runtimeStack = claimPreprovisionedRuntimeStack(
    db,
    assistant,
    runtimeStackForPayload(assistant),
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
  const assistants = db
    .query<AssistantRow & { owner_consent_json: string | null }, []>(
      `SELECT assistants.*, users.consent_json AS owner_consent_json
       FROM assistants
       JOIN users ON users.id = assistants.user_id`,
    )
    .all();
  for (const assistant of assistants) {
    if (!hasAcceptedAssistantConsent(assistant.owner_consent_json)) continue;
    const stack = runtimeStackForPayload(assistant);
    scheduleRuntimeProvisioning(assistant, stack);
  }
}

function operationalStatusPayload(
  row: AssistantRow,
  runtimeStack = runtimeStackForPayload(row),
) {
  const updatedAt = nowIso();
  const state = operationalStateForRuntimeStack(runtimeStack);
  const runtimeReady = state === "active";
  return {
    state,
    detail_state: runtimeStack.status,
    poll_after_ms: runtimeReady ? 30_000 : 5_000,
    updated_at: updatedAt,
    active_operation: null,
    assistant: {
      id: row.id,
      name: row.name,
      status: assistantApiStatusForRuntimeStack(runtimeStack),
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
    // provisioning remains consent-gated below, so session bootstrap itself
    // cannot allocate external infrastructure.
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
    if (
      body.consent !== undefined &&
      hasAcceptedAssistantConsent(user.consent_json)
    ) {
      ensureAssistantRuntime(getOrCreateAssistant(user));
    }
  }
  sendJson(req, res, {
    ...userPayload(user),
    consent: user.consent_json ? JSON.parse(user.consent_json) : null,
  });
}

function handleOrganizations(req: Request, res: Response, user: UserRow): void {
  const org = getOrCreateOrganization(user);
  sendJson(req, res, {
    count: 1,
    next: null,
    previous: null,
    results: [{ id: org.id, name: org.name }],
  });
}

async function handleAssistants(
  req: Request,
  res: Response,
  url: URL,
  user: UserRow,
): Promise<boolean> {
  if (pathEquals(url.pathname, "/v1/assistants/") && req.method === "GET") {
    const assistant = getOrCreateAssistant(user);
    const hosting = url.searchParams.get("hosting");
    const includeAssistant =
      hosting === null || hosting === "platform" || hosting === "all";
    if (!includeAssistant) {
      sendJson(req, res, { count: 0, next: null, previous: null, results: [] });
      return true;
    }
    const runtimeStack = hasAcceptedAssistantConsent(user.consent_json)
      ? ensureAssistantRuntime(assistant)
      : runtimeStackForPayload(assistant);
    const results = [assistantPayload(assistant, user, runtimeStack)];
    sendJson(req, res, {
      count: results.length,
      next: null,
      previous: null,
      results,
    });
    return true;
  }

  if (
    pathEquals(url.pathname, "/v1/assistants/active/") &&
    req.method === "GET"
  ) {
    const assistant = getOrCreateAssistant(user);
    const runtimeStack = hasAcceptedAssistantConsent(user.consent_json)
      ? ensureAssistantRuntime(assistant)
      : runtimeStackForPayload(assistant);
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
    const existing = getActiveAssistant(user);
    const assistant = existing ?? getOrCreateAssistant(user);
    const runtimeStack = ensureAssistantRuntime(assistant);
    const provisioningError = runtimeProvisioningConfigurationError();
    if (
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

  const operationalStatusMatch =
    /^\/v1\/assistants\/([^/]+)\/operational\/status\/?$/.exec(url.pathname);
  if (operationalStatusMatch && req.method === "GET") {
    const assistant = db
      .query<
        AssistantRow,
        [string, string]
      >("SELECT * FROM assistants WHERE id = ? AND user_id = ?")
      .get(operationalStatusMatch[1]!, user.id);
    if (!assistant) {
      sendJson(req, res, { detail: "Assistant not found." }, 404);
      return true;
    }
    sendJson(req, res, operationalStatusPayload(assistant));
    return true;
  }

  const assistantMatch = /^\/v1\/assistants\/([^/]+)\/?$/.exec(url.pathname);
  if (assistantMatch) {
    const assistant = db
      .query<
        AssistantRow,
        [string, string]
      >("SELECT * FROM assistants WHERE id = ? AND user_id = ?")
      .get(assistantMatch[1]!, user.id);
    if (!assistant) {
      sendJson(req, res, { detail: "Assistant not found." }, 404);
      return true;
    }
    if (req.method === "PATCH") {
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

function handleBilling(req: Request, res: Response): void {
  sendJson(req, res, {
    settled_balance: "0",
    minimum_top_up: "0",
    maximum_top_up: "0",
    maximum_balance: "0",
    allowed_top_up_amounts: [],
    settled_balance_usd: "0",
    minimum_top_up_usd: "0",
    maximum_top_up_usd: "0",
    maximum_balance_usd: "0",
    pending_compute: "0",
    pending_compute_usd: "0",
    effective_balance: "0",
    effective_balance_usd: "0",
    is_degraded: false,
  });
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
      .query<
        AssistantRow,
        [string, string]
      >("SELECT * FROM assistants WHERE id = ? AND user_id = ?")
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
      normalized === "authorization"
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
): Promise<void> {
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
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
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
  const runtimeStack = ensureRuntimeStackForAssistant(
    db,
    assistant,
    runtimeStackConfig,
    nowIso,
  );
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
  const response = await fetch(target, {
    method: req.method,
    headers,
    body: bodyBuffer ? new Uint8Array(bodyBuffer) : undefined,
    redirect: "manual",
  });
  await streamRuntimeResponse(req, res, response);
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
  const assistantId = assistantIdFromManagedVoiceRoutingToken(sessionToken);
  if (!assistantId) {
    sendJson(req, res, { error: { message: "Invalid voice session" } }, 401);
    return;
  }

  const assistant = db
    .query<AssistantRow, [string]>("SELECT * FROM assistants WHERE id = ?")
    .get(assistantId);
  if (!assistant) {
    sendJson(req, res, { error: { message: "Invalid voice session" } }, 401);
    return;
  }

  const runtimeStack = ensureRuntimeStackForAssistant(
    db,
    assistant,
    runtimeStackConfig,
    nowIso,
  );
  if (!isRuntimeStackRoutable(runtimeStack)) {
    sendJson(
      req,
      res,
      { error: { message: "Worklin voice is temporarily unavailable" } },
      503,
    );
    return;
  }

  const target = new URL(runtimeStack.gateway_url);
  target.pathname = "/v1/live-voice/providers/chat/completions";
  target.search = url.search;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value) continue;
    const normalized = key.toLowerCase();
    if (
      normalized === "host" ||
      normalized === "cookie" ||
      normalized === "content-length"
    )
      continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  const body = Buffer.isBuffer(req.body)
    ? new Uint8Array(req.body)
    : new Uint8Array(Buffer.from(parseTextBody(req)));
  const response = await fetch(target, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
  });

  res.status(response.status);
  setCorsHeaders(req, res);
  for (const [key, value] of response.headers) {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("access-control-allow-")) continue;
    if (normalized === "content-length") continue;
    res.setHeader(key, value);
  }

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
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

  const assistant = getOwnedAssistantForRuntime(db, assistantId, user.id);
  if (!assistant) {
    sendJson(req, res, { detail: "Assistant not found." }, 404);
    return;
  }

  const runtimeStack = ensureRuntimeStackForAssistant(
    db,
    assistant,
    runtimeStackConfig,
    nowIso,
  );
  if (!isRuntimeStackRoutable(runtimeStack)) {
    console.warn("proxy_missing_active_runtime_stack", {
      assistantId: assistant.id,
      userId: user.id,
      runtimeStackId: runtimeStack.id,
      runtimeStatus: runtimeStack.status,
    });
    sendJson(req, res, runtimeNotReadyPayload(runtimeStack), 503);
    return;
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

  const target = new URL(runtimeStack.gateway_url);
  target.pathname = url.pathname;
  target.search = url.search;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value) continue;
    const normalized = key.toLowerCase();
    if (
      normalized === "host" ||
      normalized === "cookie" ||
      normalized === "content-length" ||
      normalized === "authorization"
    )
      continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  headers.set(
    "Authorization",
    `Bearer ${mintActorToken(runtimeStack, tenantContext)}`,
  );
  applyRuntimeTenantHeaders(headers, tenantContext);

  const bodyBuffer =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(parseTextBody(req));
  const body = bodyBuffer ? new Uint8Array(bodyBuffer) : undefined;

  const response = await fetch(target, {
    method: req.method,
    headers,
    body,
    redirect: "manual",
  });

  res.status(response.status);
  setCorsHeaders(req, res);
  for (const [key, value] of response.headers) {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("access-control-allow-")) continue;
    if (normalized === "content-length") continue;
    res.setHeader(key, value);
  }

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
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

app.get("/healthz", (req, res) => sendJson(req, res, { ok: true }));
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
        { ok: gateway.ok, gatewayStatus: gateway.status },
        gateway.ok ? 200 : 503,
      );
    } catch {
      sendJson(req, res, { ok: false, gatewayStatus: null }, 503);
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

    if (pathEquals(url.pathname, "/v1/user/me/")) {
      await handleUserMe(req, res, user);
      return;
    }
    if (pathEquals(url.pathname, "/v1/organizations/")) {
      handleOrganizations(req, res, user);
      return;
    }
    if (pathEquals(url.pathname, "/v1/organizations/billing/summary/")) {
      handleBilling(req, res);
      return;
    }

    if (await handleArtifactInvitations(req, res, url, user)) return;
    if (await proxySharedArtifact(req, res, url, user)) return;

    if (pathIsOrStartsWith(url.pathname, "/v1/assistants/")) {
      const handled = await handleAssistants(req, res, url, user);
      if (handled) return;
      await proxyToGateway(req, res, url, user);
      return;
    }

    sendJson(req, res, { detail: "Not found." }, 404);
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

// Bun's Node HTTP compatibility can let an Express-only process exit after
// listen() unless another handle is active. Keep the control-plane alive in
// local and container runtimes.
const keepAlive = setInterval(() => {}, 2 ** 31 - 1);
server.on("close", () => clearInterval(keepAlive));
