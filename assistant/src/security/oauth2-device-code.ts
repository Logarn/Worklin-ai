/**
 * OpenAI ChatGPT subscription device authorization.
 *
 * This intentionally follows the Codex ChatGPT device-login flow instead of
 * the generic RFC 8628 endpoint shape. OpenAI's Codex endpoints first issue a
 * user code, then return a short-lived authorization code and PKCE verifier
 * after the user approves the login in ChatGPT.
 */

import { getLogger } from "../util/logger.js";
import {
  exchangeCodeForTokens,
  type OAuth2Config,
  type OAuth2TokenResult,
} from "./oauth2.js";

const log = getLogger("oauth2-device-code");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeviceCodeConfig {
  issuerUrl: string;
  deviceCodeUrl: string;
  tokenUrl: string;
  tokenExchangeUrl: string;
  clientId: string;
  scopes: string[];
  scopeSeparator?: string;
}

export interface DeviceCodeInitResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export type DeviceCodeTokenResult = OAuth2TokenResult;

export type DeviceCodePollOnceResult =
  | { status: "pending" }
  | { status: "token"; tokens: DeviceCodeTokenResult };

export class DeviceCodeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "expired_token"
      | "access_denied"
      | "request_failed"
      | "aborted",
  ) {
    super(message);
    this.name = "DeviceCodeError";
  }
}

// ---------------------------------------------------------------------------
// Well-known provider configs
// ---------------------------------------------------------------------------

export const OPENAI_DEVICE_CODE_CONFIG: DeviceCodeConfig = {
  issuerUrl: "https://auth.openai.com",
  deviceCodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  tokenUrl: "https://auth.openai.com/api/accounts/deviceauth/token",
  tokenExchangeUrl: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  scopes: ["openid", "profile", "email", "offline_access"],
  scopeSeparator: " ",
};

// ---------------------------------------------------------------------------
// Device code request
// ---------------------------------------------------------------------------

export async function requestDeviceCode(
  config: DeviceCodeConfig,
): Promise<DeviceCodeInitResult> {
  const resp = await fetch(config.deviceCodeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ client_id: config.clientId }),
  });

  if (!resp.ok) {
    const rawBody = await resp.text().catch(() => "");
    log.error(
      { status: resp.status, body: rawBody },
      "Device code request failed",
    );
    throw new DeviceCodeError(
      `Device code request failed (HTTP ${resp.status})`,
      "request_failed",
    );
  }

  const data = (await resp.json()) as Record<string, unknown>;
  const deviceAuthId =
    stringValue(data.device_auth_id) ?? stringValue(data.device_code);
  const userCode = stringValue(data.user_code);
  if (!deviceAuthId || !userCode) {
    log.error(
      { keys: Object.keys(data) },
      "Device code response missing required fields",
    );
    throw new DeviceCodeError(
      "Device code response missing required fields",
      "request_failed",
    );
  }

  return {
    deviceCode: deviceAuthId,
    userCode,
    verificationUri:
      stringValue(data.verification_uri) ??
      `${trimTrailingSlash(config.issuerUrl)}/codex/device`,
    verificationUriComplete:
      stringValue(data.verification_uri_complete) ?? undefined,
    expiresIn:
      positiveNumber(data.expires_in) ??
      secondsUntil(data.expires_at) ??
      15 * 60,
    interval: positiveNumber(data.interval) ?? 5,
  };
}

// ---------------------------------------------------------------------------
// Token polling
// ---------------------------------------------------------------------------

/**
 * Poll the Codex device-auth token endpoint until OpenAI issues an
 * authorization code, then exchange it for ChatGPT subscription tokens.
 */
export async function pollForToken(
  config: DeviceCodeConfig,
  deviceCode: string,
  userCode: string,
  intervalSeconds: number,
  expiresIn: number,
  signal?: AbortSignal,
  /** @internal Test-only: override the sleep function to avoid real delays. */
  _sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<DeviceCodeTokenResult> {
  const doSleep = _sleepFn ?? sleep;
  let interval = intervalSeconds;
  const maxWaitMs = Math.max(0, expiresIn * 1000);
  const deadline = Date.now() + maxWaitMs;
  let elapsedSleepMs = 0;

  const isTimedOut = () =>
    Date.now() >= deadline || elapsedSleepMs >= maxWaitMs;

  const sleepUntilNextPoll = async (): Promise<boolean> => {
    if (signal?.aborted) {
      throw new DeviceCodeError("Device code flow aborted", "aborted");
    }
    const remainingMs = Math.min(
      deadline - Date.now(),
      maxWaitMs - elapsedSleepMs,
    );
    if (remainingMs <= 0) {
      return false;
    }
    const sleepMs = Math.min(interval * 1000, remainingMs);
    await doSleep(sleepMs, signal);
    elapsedSleepMs += sleepMs;
    return true;
  };

  while (!isTimedOut()) {
    if (signal?.aborted) {
      throw new DeviceCodeError("Device code flow aborted", "aborted");
    }

    const body = JSON.stringify({
      device_auth_id: deviceCode,
      user_code: userCode,
    });

    let resp: Response;
    try {
      resp = await fetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        signal,
      });
    } catch (err) {
      if (signal?.aborted) {
        throw new DeviceCodeError("Device code flow aborted", "aborted");
      }
      log.warn({ err }, "Token poll request failed, will retry");
      if (!(await sleepUntilNextPoll())) break;
      continue;
    }

    if (resp.ok) {
      const data = (await resp.json()) as Record<string, unknown>;
      const authorizationCode = stringValue(data.authorization_code);
      const codeVerifier = stringValue(data.code_verifier);
      if (!authorizationCode || !codeVerifier) {
        log.error(
          { keys: Object.keys(data) },
          "Device auth poll response missing exchange fields",
        );
        throw new DeviceCodeError(
          "Device auth response missing exchange fields",
          "request_failed",
        );
      }

      const { tokens } = await exchangeCodeForTokens(
        toOAuth2Config(config),
        authorizationCode,
        `${trimTrailingSlash(config.issuerUrl)}/deviceauth/callback`,
        codeVerifier,
      );
      log.info("Device code authorization completed");
      return tokens;
    }

    const rawBody = await resp.text().catch(() => "");
    const data = parseJsonObject(rawBody);
    const errorCode =
      stringValue(data.error) ??
      stringValue(data.error_code) ??
      stringValue(data.code);
    const errorDescription =
      stringValue(data.error_description) ??
      stringValue(data.message) ??
      stringValue(data.detail);

    if (
      resp.status === 403 ||
      resp.status === 404 ||
      errorCode === "authorization_pending"
    ) {
      log.debug("Authorization pending, continuing to poll");
      if (!(await sleepUntilNextPoll())) break;
      continue;
    }

    if (errorCode === "slow_down") {
      interval += 5;
      log.info(
        { newInterval: interval },
        "Received slow_down, increasing poll interval",
      );
      if (!(await sleepUntilNextPoll())) break;
      continue;
    }

    if (errorCode === "expired_token") {
      throw new DeviceCodeError(
        "Device code expired before user completed authorization",
        "expired_token",
      );
    }

    if (errorCode === "access_denied") {
      throw new DeviceCodeError(
        "User denied the authorization request",
        "access_denied",
      );
    }

    log.error(
      { status: resp.status, error: errorCode, errorDescription },
      "Unexpected token poll error",
    );
    throw new DeviceCodeError(
      `Token poll failed: ${errorCode ?? `HTTP ${resp.status}`}${
        errorDescription ? ` (${errorDescription})` : ""
      }`,
      "request_failed",
    );
  }

  throw new DeviceCodeError(
    "Device code expired before user completed authorization",
    "expired_token",
  );
}

/**
 * Poll the Codex device-auth token endpoint once.
 *
 * This is used by hosted web status requests so the browser can carry the
 * opaque device authorization id between horizontally-scaled backend workers.
 */
export async function pollForTokenOnce(
  config: DeviceCodeConfig,
  deviceCode: string,
  userCode: string,
  signal?: AbortSignal,
): Promise<DeviceCodePollOnceResult> {
  let resp: Response;
  try {
    resp = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        device_auth_id: deviceCode,
        user_code: userCode,
      }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) {
      throw new DeviceCodeError("Device code flow aborted", "aborted");
    }
    log.warn({ err }, "Single token poll request failed");
    throw new DeviceCodeError("Token poll request failed", "request_failed");
  }

  if (resp.ok) {
    const data = (await resp.json()) as Record<string, unknown>;
    const authorizationCode = stringValue(data.authorization_code);
    const codeVerifier = stringValue(data.code_verifier);
    if (!authorizationCode || !codeVerifier) {
      log.error(
        { keys: Object.keys(data) },
        "Device auth poll response missing exchange fields",
      );
      throw new DeviceCodeError(
        "Device auth response missing exchange fields",
        "request_failed",
      );
    }

    const { tokens } = await exchangeCodeForTokens(
      toOAuth2Config(config),
      authorizationCode,
      `${trimTrailingSlash(config.issuerUrl)}/deviceauth/callback`,
      codeVerifier,
    );
    log.info("Device code authorization completed");
    return { status: "token", tokens };
  }

  const rawBody = await resp.text().catch(() => "");
  const data = parseJsonObject(rawBody);
  const errorCode =
    stringValue(data.error) ??
    stringValue(data.error_code) ??
    stringValue(data.code);
  const errorDescription =
    stringValue(data.error_description) ??
    stringValue(data.message) ??
    stringValue(data.detail);

  if (
    resp.status === 403 ||
    resp.status === 404 ||
    errorCode === "authorization_pending" ||
    errorCode === "slow_down"
  ) {
    log.debug("Authorization pending on single token poll");
    return { status: "pending" };
  }

  if (errorCode === "expired_token") {
    throw new DeviceCodeError(
      "Device code expired before user completed authorization",
      "expired_token",
    );
  }

  if (errorCode === "access_denied") {
    throw new DeviceCodeError(
      "User denied the authorization request",
      "access_denied",
    );
  }

  log.error(
    { status: resp.status, error: errorCode, errorDescription },
    "Unexpected single token poll error",
  );
  throw new DeviceCodeError(
    `Token poll failed: ${errorCode ?? `HTTP ${resp.status}`}${
      errorDescription ? ` (${errorDescription})` : ""
    }`,
    "request_failed",
  );
}

// ---------------------------------------------------------------------------
// Combined flow
// ---------------------------------------------------------------------------

export interface DeviceCodeFlowResult {
  tokens: DeviceCodeTokenResult;
  init: DeviceCodeInitResult;
}

/**
 * Run the full device-code flow:
 * 1. Request a device code + user code
 * 2. Return the user code and verification URI (caller shows these to the user)
 * 3. Poll for the token
 *
 * The returned `init` contains the user code and verification URI that the
 * caller should present to the user before awaiting `tokens`.
 */
export async function startDeviceCodeFlow(
  config: DeviceCodeConfig,
  signal?: AbortSignal,
): Promise<DeviceCodeFlowResult> {
  const init = await requestDeviceCode(config);

  log.info(
    {
      verificationUri: init.verificationUri,
      expiresIn: init.expiresIn,
      interval: init.interval,
    },
    "Device code flow started",
  );

  const tokens = await pollForToken(
    config,
    init.deviceCode,
    init.userCode,
    init.interval,
    init.expiresIn,
    signal,
  );

  return { tokens, init };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DeviceCodeError("Device code flow aborted", "aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DeviceCodeError("Device code flow aborted", "aborted"));
      },
      { once: true },
    );
  });
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function secondsUntil(value: unknown): number | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const expiresAt = Date.parse(raw);
  if (!Number.isFinite(expiresAt)) return undefined;
  const seconds = Math.ceil((expiresAt - Date.now()) / 1000);
  return seconds > 0 ? seconds : undefined;
}

function parseJsonObject(rawBody: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toOAuth2Config(config: DeviceCodeConfig): OAuth2Config {
  const issuerUrl = trimTrailingSlash(config.issuerUrl);
  return {
    authorizeUrl: `${issuerUrl}/oauth/authorize`,
    tokenExchangeUrl: config.tokenExchangeUrl,
    clientId: config.clientId,
    scopes: config.scopes,
    scopeSeparator: config.scopeSeparator ?? " ",
  };
}
