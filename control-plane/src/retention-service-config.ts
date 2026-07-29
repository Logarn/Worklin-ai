const DEFAULT_TOKEN_TTL_SECONDS = 30;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;

const MIN_TOKEN_TTL_SECONDS = 5;
const MAX_TOKEN_TTL_SECONDS = 300;
const MIN_REQUEST_TIMEOUT_MS = 100;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const MIN_REQUEST_BODY_BYTES = 1;
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
const MIN_SECRET_BYTES = 32;

export interface DisabledRetentionServiceConfig {
  enabled: false;
}

export interface EnabledRetentionServiceConfig {
  enabled: true;
  internalBaseUrl: string;
  serviceJwtSecret: string;
  providerWebhookSecret: string;
  tokenTtlSeconds: number;
  requestTimeoutMs: number;
  maxRequestBodyBytes: number;
}

export type RetentionServiceConfig =
  | DisabledRetentionServiceConfig
  | EnabledRetentionServiceConfig;

export type RetentionServiceEnvironment = Record<
  string,
  string | undefined
>;

export function parseRetentionServiceConfig(
  env: RetentionServiceEnvironment,
): RetentionServiceConfig {
  if (env.WORKLIN_RETENTION_SERVICE_ENABLED !== "true") {
    return { enabled: false };
  }

  const internalBaseUrl = parseInternalBaseUrl(
    requireEnv(env, "WORKLIN_RETENTION_SERVICE_URL"),
  );
  const serviceJwtSecret = requireSecret(
    env,
    "WORKLIN_RETENTION_SERVICE_JWT_SECRET",
  );
  const providerWebhookSecret = requireSecret(
    env,
    "WORKLIN_RETENTION_SERVICE_WEBHOOK_SECRET",
  );
  if (serviceJwtSecret === providerWebhookSecret) {
    throw new Error(
      "Retention service JWT and provider webhook secrets must be distinct.",
    );
  }

  return {
    enabled: true,
    internalBaseUrl,
    serviceJwtSecret,
    providerWebhookSecret,
    tokenTtlSeconds: parseBoundedInteger(
      env.WORKLIN_RETENTION_SERVICE_TOKEN_TTL_SECONDS,
      DEFAULT_TOKEN_TTL_SECONDS,
      MIN_TOKEN_TTL_SECONDS,
      MAX_TOKEN_TTL_SECONDS,
      "Retention service token TTL",
    ),
    requestTimeoutMs: parseBoundedInteger(
      env.WORKLIN_RETENTION_SERVICE_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      MIN_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS,
      "Retention service request timeout",
    ),
    maxRequestBodyBytes: parseBoundedInteger(
      env.WORKLIN_RETENTION_SERVICE_MAX_BODY_BYTES,
      DEFAULT_MAX_REQUEST_BODY_BYTES,
      MIN_REQUEST_BODY_BYTES,
      MAX_REQUEST_BODY_BYTES,
      "Retention service request body limit",
    ),
  };
}

function parseInternalBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Retention service URL is invalid.");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "Retention service URL must be an HTTP(S) origin without credentials, path, query, or fragment.",
    );
  }

  url.pathname = "/";
  return url.toString();
}

function requireEnv(
  env: RetentionServiceEnvironment,
  key: string,
): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required when the retention service is enabled.`);
  }
  return value;
}

function requireSecret(
  env: RetentionServiceEnvironment,
  key: string,
): string {
  const value = requireEnv(env, key);
  if (Buffer.byteLength(value, "utf8") < MIN_SECRET_BYTES) {
    throw new Error(`${key} must contain at least ${MIN_SECRET_BYTES} bytes.`);
  }
  return value;
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) {
    throw new Error(`${label} must be an integer.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}
