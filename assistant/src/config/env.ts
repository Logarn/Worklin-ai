/**
 * Centralized environment variable access with validation.
 *
 * All runtime environment variables should be accessed through this module
 * instead of reading process.env directly. This provides:
 * - Single source of truth for env var names and defaults
 * - Type-safe accessors (string, number, boolean)
 * - Fail-fast validation via validateEnv() at startup
 * - Shared derived values (e.g. gateway base URL) instead of duplicated logic
 *
 * Bootstrap-level env vars (IS_CONTAINERIZED, DEBUG_STDOUT_LOGS) are defined
 * in config/env-registry.ts which has no internal dependencies and can be
 * imported from platform/logger without circular imports.
 */

import { getLogger } from "../util/logger.js";
import { checkUnrecognizedEnvVars, getIsPlatform } from "./env-registry.js";
import { getConfig } from "./loader.js";

const log = getLogger("env");

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Read an env var as a trimmed non-empty string, or undefined. */
function str(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || undefined;
}

/** Read an env var as an integer with fallback. Returns undefined if not set and no fallback given. */
function int(name: string, fallback: number): number;
function int(name: string): number | undefined;
function int(name: string, fallback?: number): number | undefined {
  const raw = str(name);
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (isNaN(n)) {
    throw new Error(
      `Invalid integer for ${name}: "${raw}"${
        fallback !== undefined ? ` (fallback: ${fallback})` : ""
      }`,
    );
  }
  return n;
}

// ── Gateway ──────────────────────────────────────────────────────────────────

const DEFAULT_GATEWAY_PORT = 7830;

function getGatewayPort(): number {
  return int("GATEWAY_PORT", DEFAULT_GATEWAY_PORT);
}

/**
 * Resolve the gateway base URL for internal service-to-service calls.
 *
 * In containerized deployments the gateway runs in a separate container,
 * reachable via `GATEWAY_INTERNAL_URL` (e.g. `http://gateway:7822`).
 * Falls back to `http://127.0.0.1:<GATEWAY_PORT>` for local deployments.
 */
export function getGatewayInternalBaseUrl(): string {
  return str("GATEWAY_INTERNAL_URL") ?? `http://127.0.0.1:${getGatewayPort()}`;
}

// ── Ingress ──────────────────────────────────────────────────────────────────

let _ingressPublicBaseUrl: string | undefined;

/** Read the ingress public base URL (module-level state, mutated at runtime by config handlers). */
export function getIngressPublicBaseUrl(): string | undefined {
  return _ingressPublicBaseUrl;
}

/** Set or clear the ingress public base URL (used by config handlers). */
export function setIngressPublicBaseUrl(value: string | undefined): void {
  _ingressPublicBaseUrl = value;
}

// ── Runtime HTTP ─────────────────────────────────────────────────────────────

export function getRuntimeHttpPort(): number {
  return int("RUNTIME_HTTP_PORT") ?? 7821;
}

export function getRuntimeHttpHost(): string {
  return str("RUNTIME_HTTP_HOST") || "127.0.0.1";
}

/**
 * True when HTTP API auth is disabled via DISABLE_HTTP_AUTH=true.
 * Platform tenant runtimes always keep HTTP authentication enabled.
 */
export function isHttpAuthDisabled(): boolean {
  return (
    str("DISABLE_HTTP_AUTH")?.toLowerCase() === "true" &&
    !isPlatformIsolatedRuntime()
  );
}

// ── Monitoring ───────────────────────────────────────────────────────────────

export function getSentryDsn(): string {
  return str("SENTRY_DSN_ASSISTANT") ?? "";
}

// ── Qdrant ───────────────────────────────────────────────────────────────────

export function getQdrantUrlEnv(): string | undefined {
  return str("QDRANT_URL");
}

export function getQdrantHttpPortEnv(): number | undefined {
  return int("QDRANT_HTTP_PORT");
}

export function getQdrantReadyzTimeoutMs(): number | undefined {
  return int("QDRANT_READYZ_TIMEOUT_MS");
}

// ── Ollama ───────────────────────────────────────────────────────────────────

export function getOllamaBaseUrlEnv(): string | undefined {
  return str("OLLAMA_BASE_URL");
}

// ── Platform ─────────────────────────────────────────────────────────────────

let _platformBaseUrlOverride: string | undefined;

export function setPlatformBaseUrl(value: string | undefined): void {
  _platformBaseUrlOverride = value;
}

export function getPlatformBaseUrl(): string {
  let configUrl: string | undefined;
  try {
    const val = getConfig().platform.baseUrl;
    if (val) configUrl = val;
  } catch {
    // Config not yet available (early bootstrap) — fall through
  }
  // Resolve the default platform URL from VELLUM_ENVIRONMENT.
  // `production`, `staging`, and `test` map to their respective hosted
  // platforms, `local` points at a developer's locally running platform,
  // and everything else (including unset) falls back to dev-platform.
  const env = str("VELLUM_ENVIRONMENT")?.trim();
  let defaultUrl: string;
  if (env === "production") {
    defaultUrl = "https://platform.vellum.ai";
  } else if (env === "staging") {
    defaultUrl = "https://staging-platform.vellum.ai";
  } else if (env === "test") {
    defaultUrl = "https://test-platform.vellum.ai";
  } else if (env === "local") {
    defaultUrl = "http://localhost:8000";
  } else {
    defaultUrl = "https://dev-platform.vellum.ai";
  }
  return (
    configUrl ||
    str("VELLUM_PLATFORM_URL") ||
    _platformBaseUrlOverride ||
    defaultUrl
  );
}

/**
 * Returns the environment-level apex domain (e.g. "vellum.me",
 * "dev.vellum.me", "staging.vellum.me"). Never includes the
 * assistant-specific subdomain.
 */
export function getApexDomain(): string {
  try {
    const url = getPlatformBaseUrl();
    const host = new URL(url).hostname;

    if (host.endsWith("platform.vellum.ai")) {
      const prefix = host.replace(/[-.]?platform\.vellum\.ai$/, "");
      if (prefix) {
        return `${prefix}.vellum.me`;
      }
      return "vellum.me";
    }

    const env = str("VELLUM_ENVIRONMENT")?.trim();
    if (env && env !== "production") {
      return `${env}.vellum.me`;
    }
    return "local.vellum.me";
  } catch {
    // Fall through to default
  }
  return "vellum.me";
}

export function getAssistantDomain(): string {
  const subdomain = (() => {
    try {
      return getConfig().platform?.subdomain;
    } catch {
      return undefined;
    }
  })();
  const apex = getApexDomain();
  if (subdomain) {
    return `${subdomain}.${apex}`;
  }
  return apex;
}

let _platformAssistantIdOverride: string | undefined;

export function setPlatformAssistantId(value: string | undefined): void {
  _platformAssistantIdOverride = value;
}

/**
 * Platform assistant ID — UUID of this assistant on the platform.
 *
 * Resolved from the immutable runtime binding first, then the in-memory
 * override populated by providers-setup rehydration or secret-routes.
 */
export function getPlatformAssistantId(): string {
  return (
    str("WORKLIN_PLATFORM_ASSISTANT_ID") ?? _platformAssistantIdOverride ?? ""
  );
}

/**
 * True when this daemon runs inside a platform tenant boundary.
 *
 * Dedicated and pooled workers authenticate every shared HTTP/IPC request
 * even if a stale deployment still carries DISABLE_HTTP_AUTH=true. Local and
 * self-hosted daemons retain the development bypass.
 */
export function isPlatformIsolatedRuntime(): boolean {
  const runtimeMode = str("WORKLIN_RUNTIME_MODE")?.toLowerCase();
  const scopeMode = str("RUNTIME_ASSISTANT_SCOPE_MODE")?.toLowerCase();
  const pooledStateTransport =
    str("WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED")?.toLowerCase() ===
    "true";
  return (
    runtimeMode === "isolated" ||
    runtimeMode === "pooled" ||
    runtimeMode === "pooled_worker" ||
    scopeMode === "enforce" ||
    scopeMode === "claim_once" ||
    pooledStateTransport ||
    Boolean(str("WORKLIN_RUNTIME_WORKER_STACK_ID")) ||
    Boolean(str("WORKLIN_PLATFORM_ASSISTANT_ID"))
  );
}

export function isPooledWorkerRuntime(): boolean {
  const runtimeMode = str("WORKLIN_RUNTIME_MODE")?.toLowerCase();
  return (
    runtimeMode === "pooled" ||
    runtimeMode === "pooled_worker" ||
    Boolean(str("WORKLIN_RUNTIME_WORKER_STACK_ID"))
  );
}

export function getRuntimeWorkerStackId(): string {
  return str("WORKLIN_RUNTIME_WORKER_STACK_ID") ?? "";
}

export function getRuntimeWorkerLeaseAuthorityFile(): string {
  return str("WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE") ?? "";
}

let _platformOrganizationIdOverride: string | undefined;

export function setPlatformOrganizationId(value: string | undefined): void {
  _platformOrganizationIdOverride = value;
}

/**
 * PLATFORM_ORGANIZATION_ID — UUID of the organization this assistant belongs to.
 * Used for Sentry tagging and platform API calls.
 */
export function getPlatformOrganizationId(): string {
  return (
    str("PLATFORM_ORGANIZATION_ID") ?? _platformOrganizationIdOverride ?? ""
  );
}

let _platformUserIdOverride: string | undefined;

export function setPlatformUserId(value: string | undefined): void {
  _platformUserIdOverride = value;
}

/**
 * PLATFORM_USER_ID — UUID of the user who owns this assistant.
 * Used for telemetry and platform API calls.
 */
export function getPlatformUserId(): string {
  return str("PLATFORM_USER_ID") ?? _platformUserIdOverride ?? "";
}

/** Clear process-local platform identity left by a prior pooled assignment. */
export function resetPlatformRuntimeIdentityOverrides(): void {
  _platformBaseUrlOverride = undefined;
  _platformAssistantIdOverride = undefined;
  _platformOrganizationIdOverride = undefined;
  _platformUserIdOverride = undefined;
}

// ── Startup validation ──────────────────────────────────────────────────────

export const POOLED_FORBIDDEN_GLOBAL_SECRET_ENV_VARS = Object.freeze([
  "CES_SERVICE_TOKEN",
  "ASSISTANT_API_KEY",
  "GUARDIAN_BOOTSTRAP_SECRET",
  "WORKLIN_RUNTIME_WORKER_OPERATOR_RECOVERY_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_GEMINI_API_KEY",
  "FIREWORKS_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
  "MINIMAX_API_KEY",
  "OLLAMA_API_KEY",
  "BRAVE_API_KEY",
  "PERPLEXITY_API_KEY",
  "TAVILY_API_KEY",
  "DEEPGRAM_API_KEY",
  "XAI_API_KEY",
  "GITHUB_TOKEN",
  "HUME_API_KEY",
  "ELEVENLABS_API_KEY",
  "FISH_AUDIO_API_KEY",
  "TWILIO_AUTH_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "WHATSAPP_ACCESS_TOKEN",
  "RESEND_API_KEY",
  "MAILGUN_API_KEY",
  "WORKLIN_PLATFORM_ASSISTANT_ID",
  "PLATFORM_ORGANIZATION_ID",
  "PLATFORM_USER_ID",
] as const);

/**
 * Validate environment at startup. Call early in daemon lifecycle
 * (after dotenv loads). Throws on invalid required values; warns on
 * deprecated vars.
 */
export function validateEnv(): void {
  const gatewayPort = getGatewayPort();
  if (gatewayPort < 1 || gatewayPort > 65535) {
    throw new Error(`Invalid GATEWAY_PORT: ${gatewayPort} (must be 1-65535)`);
  }

  const httpPort = getRuntimeHttpPort();
  if (httpPort < 1 || httpPort > 65535) {
    throw new Error(`Invalid RUNTIME_HTTP_PORT: ${httpPort} (must be 1-65535)`);
  }

  if (isPooledWorkerRuntime()) {
    if (!getIsPlatform()) {
      throw new Error("Pooled workers require IS_PLATFORM=true.");
    }

    if (
      POOLED_FORBIDDEN_GLOBAL_SECRET_ENV_VARS.some((name) => Boolean(str(name)))
    ) {
      throw new Error(
        "Pooled workers must not receive global integration credentials or tenant identity environment variables.",
      );
    }

    const workerStackId = getRuntimeWorkerStackId();
    const authorityFile = getRuntimeWorkerLeaseAuthorityFile();
    if (!workerStackId || !authorityFile) {
      throw new Error(
        "Pooled workers require WORKLIN_RUNTIME_WORKER_STACK_ID and WORKLIN_RUNTIME_WORKER_LEASE_AUTHORITY_FILE.",
      );
    }
    const stateTransportEnabled =
      str("WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED")?.toLowerCase() ===
      "true";
    const stateProvider =
      str("WORKLIN_RUNTIME_WORKER_STATE_PROVIDER")?.toLowerCase() ?? "gcs";
    const stateBucket = str("WORKLIN_RUNTIME_WORKER_STATE_BUCKET") ?? "";
    if (!stateTransportEnabled || !stateBucket) {
      throw new Error(
        "Pooled workers require WORKLIN_RUNTIME_WORKER_STATE_TRANSPORT_ENABLED=true and WORKLIN_RUNTIME_WORKER_STATE_BUCKET.",
      );
    }
    if (
      !/^[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]$/u.test(stateBucket) ||
      stateBucket.includes("..") ||
      stateBucket.startsWith("goog") ||
      /^(\d{1,3}\.){3}\d{1,3}$/u.test(stateBucket)
    ) {
      throw new Error("WORKLIN_RUNTIME_WORKER_STATE_BUCKET is invalid.");
    }
    if (stateProvider !== "gcs" && stateProvider !== "s3") {
      throw new Error("WORKLIN_RUNTIME_WORKER_STATE_PROVIDER is invalid.");
    }
    if (
      [
        "WORKLIN_RUNTIME_WORKER_STATE_GCS_SERVICE_ACCOUNT_JSON",
        "WORKLIN_RUNTIME_WORKER_STATE_S3_ACCESS_KEY_ID",
        "WORKLIN_RUNTIME_WORKER_STATE_S3_SECRET_ACCESS_KEY",
        "ACCESS_KEY_ID",
        "SECRET_ACCESS_KEY",
        "S3_ACCESS_KEY_ID",
        "S3_SECRET_ACCESS_KEY",
        "S3_SESSION_TOKEN",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
      ].some((name) => Boolean(str(name)))
    ) {
      throw new Error(
        "Pooled workers must not receive object-storage credentials.",
      );
    }
    if (stateProvider === "s3") {
      const endpointValue =
        str("WORKLIN_RUNTIME_WORKER_STATE_S3_ENDPOINT") ?? "";
      const region = str("WORKLIN_RUNTIME_WORKER_STATE_S3_REGION") ?? "";
      const style =
        str("WORKLIN_RUNTIME_WORKER_STATE_S3_URL_STYLE") ?? "virtual";
      let endpoint: URL;
      try {
        endpoint = new URL(endpointValue);
      } catch {
        throw new Error("WORKLIN_RUNTIME_WORKER_STATE_S3_ENDPOINT is invalid.");
      }
      if (
        endpoint.protocol !== "https:" ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.port ||
        (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
        !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
          endpoint.hostname,
        ) ||
        /^(\d{1,3}\.){3}\d{1,3}$/u.test(endpoint.hostname) ||
        endpoint.hostname.startsWith("[") ||
        endpoint.hostname.endsWith(".localhost") ||
        endpoint.hostname.endsWith(".local") ||
        !region ||
        (style !== "path" && style !== "virtual") ||
        (style === "virtual" && stateBucket.includes("."))
      ) {
        throw new Error("Pooled worker Railway S3 state metadata is invalid.");
      }
    }
  }

  for (const warning of checkUnrecognizedEnvVars()) {
    log.warn(warning);
  }
}
