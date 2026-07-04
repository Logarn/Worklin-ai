/**
 * Route definitions for ChatGPT subscription OAuth authentication.
 *
 * POST /v1/inference/chatgpt-subscription/auth — generate a PKCE authorize
 *   URL for the user to visit. Returns `{ authorize_url, state,
 *   code_verifier }`.
 *
 * POST /v1/inference/chatgpt-subscription/auth/exchange — accept the
 *   authorization code + state from the redirect, exchange for tokens,
 *   store in CES, and upsert the provider connection.
 */

import { createServer, type Server } from "node:http";

import { z } from "zod";

import { getDb } from "../../memory/db-connection.js";
import {
  getConnection,
  upsertConnection,
} from "../../providers/inference/connections.js";
import { renderOAuthCompletionPage } from "../../security/oauth-completion-page.js";
import type { OAuth2Config } from "../../security/oauth2.js";
import {
  exchangeCodeForTokens,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  type OAuth2TokenResult,
} from "../../security/oauth2.js";
import {
  DeviceCodeError,
  OPENAI_DEVICE_CODE_CONFIG,
  pollForTokenOnce,
  requestDeviceCode,
} from "../../security/oauth2-device-code.js";
import {
  bulkSetSecureKeysAsync,
  getActiveBackendName,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("chatgpt-subscription-auth");

// ---------------------------------------------------------------------------
// OAuth config
// ---------------------------------------------------------------------------

const OPENAI_OAUTH_CONFIG: OAuth2Config = {
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenExchangeUrl: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  scopes: ["openid", "profile", "email", "offline_access"],
  scopeSeparator: " ",
  authorizeParams: { id_token_add_organizations: "true" },
};

const REDIRECT_URI = "http://localhost:1455/auth/callback";
const CONNECTION_NAME = "chatgpt-subscription";

// ---------------------------------------------------------------------------
// Module-level PKCE state storage
// ---------------------------------------------------------------------------

type PendingAuthMode = "device_code" | "loopback";
type PendingAuthStatus = "pending" | "exchanging" | "completed" | "failed";

interface PendingAuth {
  mode: PendingAuthMode;
  codeVerifier?: string;
  createdAt: number;
  status: PendingAuthStatus;
  callbackListening: boolean;
  server?: Server;
  pollAbort?: AbortController;
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresAt?: number;
  error?: string;
}

const pendingAuths = new Map<string, PendingAuth>();

const LOOPBACK_AUTH_TTL_MS = 10 * 60 * 1000; // 10 minutes
const EXPIRED_AUTH_MESSAGE =
  "This ChatGPT sign-in expired before Worklin could finish it. Start a fresh ChatGPT sign-in and try again.";
const CONNECTION_COMPLETION_CLOCK_SKEW_MS = 5_000;

function pendingAuthExpiresAt(entry: PendingAuth): number {
  return entry.expiresAt ?? entry.createdAt + LOOPBACK_AUTH_TTL_MS;
}

/** Remove entries after the flow-specific expiry window. */
function cleanupExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of pendingAuths) {
    if (pendingAuthExpiresAt(entry) < now) {
      closePendingAuth(entry);
      pendingAuths.delete(key);
    }
  }
}

function closePendingServer(entry: PendingAuth): void {
  if (!entry.server) return;
  try {
    entry.server.close();
  } catch {
    // Best effort: the server may already be closing after a callback.
  }
  entry.server = undefined;
  entry.callbackListening = false;
}

function closePendingAuth(entry: PendingAuth): void {
  closePendingServer(entry);
  if (entry.pollAbort) {
    entry.pollAbort.abort();
    entry.pollAbort = undefined;
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeDeviceErrorMessage(error: unknown): string {
  if (error instanceof DeviceCodeError) {
    if (error.code === "expired_token") {
      return "This ChatGPT sign-in code expired before approval finished. Start a fresh ChatGPT sign-in and try again.";
    }
    if (error.code === "access_denied") {
      return "ChatGPT sign-in was not approved. Start again when you are ready to connect your subscription.";
    }
    if (error.code === "aborted") {
      return "ChatGPT sign-in was cancelled before it finished.";
    }
    if (error.code === "request_failed") {
      return safeErrorMessage(error);
    }
    return "ChatGPT did not start the sign-in flow. Please try again in a moment.";
  }
  return safeErrorMessage(error);
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

async function persistChatgptTokens(tokens: OAuth2TokenResult): Promise<void> {
  if (!tokens.accessToken || typeof tokens.accessToken !== "string") {
    log.error("ChatGPT token exchange completed without an access token");
    throw new Error("ChatGPT did not return an access token");
  }

  const credentials: Array<{ account: string; value: string }> = [
    {
      account: "credential/chatgpt/access_token",
      value: tokens.accessToken,
    },
  ];

  if (tokens.refreshToken) {
    credentials.push({
      account: "credential/chatgpt/refresh_token",
      value: tokens.refreshToken,
    });
  }

  if (tokens.expiresIn) {
    const expiresAt = Math.floor(Date.now() / 1000 + tokens.expiresIn);
    credentials.push({
      account: "credential/chatgpt/expires_at",
      value: String(expiresAt),
    });
  }

  const results = await bulkSetSecureKeysAsync(credentials);
  const retryResults = await Promise.all(
    results
      .filter((result) => !result.ok)
      .map(async (result) => ({
        account: result.account,
        ok: await setSecureKeyAsync(
          result.account,
          credentials.find(
            (credential) => credential.account === result.account,
          )?.value ?? "",
        ),
      })),
  );
  const retryByAccount = new Map(
    retryResults.map((result) => [result.account, result.ok]),
  );
  const failed = results.filter(
    (result) => !result.ok && retryByAccount.get(result.account) !== true,
  );
  if (failed.length > 0) {
    const failedAccounts = failed.map((result) => result.account);
    log.error(
      {
        failedAccounts,
        backend: getActiveBackendName(),
      },
      "Failed to store ChatGPT credentials in CES",
    );
    throw new Error(
      `Failed to store ChatGPT credentials (failed: ${failedAccounts.join(", ")}; backend: ${getActiveBackendName()})`,
    );
  }

  // Upsert provider connection
  const db = getDb();
  const authInput = {
    type: "oauth_subscription" as const,
    credential: "credential/chatgpt/access_token",
  };

  const upsertResult = upsertConnection(db, {
    name: CONNECTION_NAME,
    provider: "openai",
    auth: authInput,
    label: "ChatGPT Subscription",
    baseUrl: null,
    models: null,
  });
  if (!upsertResult.ok) {
    log.error(
      { error: upsertResult.error },
      "Failed to save chatgpt-subscription connection",
    );
    throw new Error(`Failed to save connection (${upsertResult.error.code})`);
  }
}

function isValidCodeVerifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

async function exchangeAndPersistTokens(
  code: string,
  codeVerifier: string,
): Promise<{ ok: true }> {
  const { tokens } = await exchangeCodeForTokens(
    OPENAI_OAUTH_CONFIG,
    code,
    REDIRECT_URI,
    codeVerifier,
  );

  await persistChatgptTokens(tokens);
  return { ok: true };
}

async function completePendingAuth(
  state: string,
  code: string,
  clientCodeVerifier?: string,
): Promise<{ ok: true }> {
  const pending = pendingAuths.get(state);
  if (!pending) {
    if (!isValidCodeVerifier(clientCodeVerifier)) {
      throw new BadRequestError(
        "This ChatGPT sign-in link expired before Worklin could finish it. Create a new ChatGPT sign-in link and try again.",
      );
    }

    const result = await exchangeAndPersistTokens(code, clientCodeVerifier);
    log.info(
      "ChatGPT subscription auth flow completed with browser-held verifier",
    );
    return result;
  }

  if (pending.status === "completed") {
    return { ok: true };
  }
  if (pending.status === "exchanging") {
    throw new Error("Auth exchange is already in progress.");
  }
  if (pending.status === "failed") {
    throw new Error(pending.error ?? "Auth flow failed. Please try again.");
  }
  if (pending.mode !== "loopback") {
    throw new BadRequestError(
      "This ChatGPT sign-in is waiting for approval in ChatGPT. Finish it in the browser, or start a fresh sign-in.",
    );
  }
  if (!isValidCodeVerifier(pending.codeVerifier)) {
    closePendingAuth(pending);
    pending.status = "failed";
    pending.error =
      "This ChatGPT sign-in link is missing required security details. Create a new ChatGPT sign-in link and try again.";
    throw new BadRequestError(pending.error);
  }

  // Check TTL
  if (Date.now() - pending.createdAt > LOOPBACK_AUTH_TTL_MS) {
    closePendingAuth(pending);
    pending.status = "failed";
    pending.error = EXPIRED_AUTH_MESSAGE;
    throw new BadRequestError(pending.error);
  }

  pending.status = "exchanging";
  pending.error = undefined;
  closePendingServer(pending);

  try {
    await exchangeAndPersistTokens(code, pending.codeVerifier);
    pending.status = "completed";
    log.info("ChatGPT subscription auth flow completed successfully");
    return { ok: true };
  } catch (error) {
    pending.status = "failed";
    pending.error = safeErrorMessage(error);
    throw error;
  }
}

async function startDeviceCodeAuth(state: string) {
  const init = await requestDeviceCode(OPENAI_DEVICE_CODE_CONFIG);
  const startedAt = Date.now();
  const expiresAt = startedAt + init.expiresIn * 1000;
  const pending: PendingAuth = {
    mode: "device_code",
    createdAt: startedAt,
    status: "pending",
    callbackListening: false,
    deviceCode: init.deviceCode,
    userCode: init.userCode,
    verificationUri: init.verificationUri,
    verificationUriComplete: init.verificationUriComplete,
    expiresAt,
  };

  pendingAuths.set(state, pending);

  return {
    authorize_url: init.verificationUriComplete ?? init.verificationUri,
    state,
    mode: "device_code" as const,
    callback_listening: false,
    device_code: init.deviceCode,
    user_code: init.userCode,
    verification_uri: init.verificationUri,
    verification_uri_complete: init.verificationUriComplete ?? null,
    expires_at: expiresAt,
    expires_in: init.expiresIn,
    started_at: startedAt,
    interval: init.interval,
  };
}

async function startLoopbackAuth(state: string) {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  pendingAuths.set(state, {
    mode: "loopback",
    codeVerifier,
    createdAt: Date.now(),
    status: "pending",
    callbackListening: false,
  });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH_CONFIG.clientId,
    redirect_uri: REDIRECT_URI,
    scope: OPENAI_OAUTH_CONFIG.scopes.join(OPENAI_OAUTH_CONFIG.scopeSeparator),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    ...OPENAI_OAUTH_CONFIG.authorizeParams,
  });

  const authorizeUrl = `${OPENAI_OAUTH_CONFIG.authorizeUrl}?${params.toString()}`;

  const callbackListening = await startLoopbackCallbackServer(state);

  return {
    authorize_url: authorizeUrl,
    state,
    mode: "loopback" as const,
    // The hosted web app keeps this verifier in memory and sends it back only
    // for the manual paste path. That avoids production instance affinity for
    // PKCE state while preserving the existing loopback path for local users.
    code_verifier: codeVerifier,
    callback_listening: callbackListening,
  };
}

async function startLoopbackCallbackServer(state: string): Promise<boolean> {
  const pending = pendingAuths.get(state);
  if (!pending) return false;

  return await new Promise<boolean>((resolve) => {
    let resolved = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (url.pathname !== "/auth/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const callbackState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (callbackState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(renderOAuthCompletionPage("Invalid state parameter", false));
        return;
      }

      if (error) {
        const errorDesc = url.searchParams.get("error_description") ?? error;
        pending.status = "failed";
        pending.error = `Authorization failed: ${errorDesc}`;
        closePendingServer(pending);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(renderOAuthCompletionPage(pending.error, false));
        return;
      }

      if (!code) {
        pending.status = "failed";
        pending.error = "OAuth callback missing authorization code.";
        closePendingServer(pending);
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(renderOAuthCompletionPage("Missing authorization code", false));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        renderOAuthCompletionPage(
          "You can close this tab and return to Worklin.",
          true,
        ),
      );

      void completePendingAuth(state, code).catch((err) => {
        log.error(
          { err: safeErrorMessage(err) },
          "ChatGPT subscription loopback completion failed",
        );
      });
    });

    server.on("error", (err) => {
      log.warn(
        { err: err.message },
        "ChatGPT subscription loopback callback server unavailable",
      );
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    });

    server.listen(1455, "localhost", () => {
      pending.server = server;
      pending.callbackListening = true;
      if (!resolved) {
        resolved = true;
        resolve(true);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleStartAuth(_args: RouteHandlerArgs) {
  cleanupExpiredEntries();

  const state = generateState();
  const body = _args.body as { transport?: string } | undefined;

  if (body?.transport === "loopback") {
    return await startLoopbackAuth(state);
  }

  return await startDeviceCodeAuth(state);
}

async function handleExchange(args: RouteHandlerArgs) {
  const { code, state, code_verifier } = args.body as {
    code: string;
    state: string;
    code_verifier?: string;
  };
  return await completePendingAuth(state, code, code_verifier);
}

function statusParams(args: RouteHandlerArgs): Record<string, unknown> {
  if (args.body && typeof args.body === "object") {
    return args.body as Record<string, unknown>;
  }
  return (args.queryParams ?? {}) as Record<string, unknown>;
}

function completedDeviceStatus(
  userCode?: string,
  expiresAt?: number,
  startedAt?: number,
) {
  return {
    mode: "device_code" as const,
    status: "completed" as const,
    callback_listening: false,
    user_code: userCode,
    expires_at: expiresAt,
    started_at: startedAt,
  };
}

function hasPersistedChatgptConnectionSince(startedAt?: number): boolean {
  if (!startedAt) return false;
  const connection = getConnection(getDb(), CONNECTION_NAME);
  if (!connection) return false;
  return (
    connection.updatedAt >= startedAt - CONNECTION_COMPLETION_CLOCK_SKEW_MS
  );
}

function isDuplicateDeviceRedemptionError(error: unknown): boolean {
  if (!(error instanceof DeviceCodeError) || error.code !== "request_failed") {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    (message.includes("already") && message.includes("redeem")) ||
    message.includes("invalid_grant")
  );
}

async function pollAndPersistDeviceStatus(args: {
  deviceCode: string;
  userCode: string;
  expiresAt?: number;
  startedAt?: number;
  pending?: PendingAuth;
}) {
  const { deviceCode, userCode, expiresAt, startedAt, pending } = args;

  if (expiresAt && expiresAt < Date.now()) {
    if (pending) {
      pending.status = "failed";
      pending.error = EXPIRED_AUTH_MESSAGE;
    }
    return {
      mode: "device_code" as const,
      status: "expired" as const,
      callback_listening: false,
      error: EXPIRED_AUTH_MESSAGE,
      user_code: userCode,
      expires_at: expiresAt,
      started_at: startedAt,
    };
  }

  try {
    const result = await pollForTokenOnce(
      OPENAI_DEVICE_CODE_CONFIG,
      deviceCode,
      userCode,
    );

    if (result.status === "pending") {
      return {
        mode: "device_code" as const,
        status: "pending" as const,
        callback_listening: false,
        user_code: userCode,
        expires_at: expiresAt,
        started_at: startedAt,
      };
    }

    if (pending) {
      pending.status = "exchanging";
      pending.error = undefined;
    }
    await persistChatgptTokens(result.tokens);
    if (pending) {
      pending.status = "completed";
    }
    log.info("ChatGPT subscription device-code auth completed successfully");
    return completedDeviceStatus(userCode, expiresAt, startedAt);
  } catch (error) {
    if (
      isDuplicateDeviceRedemptionError(error) &&
      hasPersistedChatgptConnectionSince(startedAt)
    ) {
      if (pending) {
        pending.status = "completed";
        pending.error = undefined;
      }
      return completedDeviceStatus(userCode, expiresAt, startedAt);
    }

    const message = safeDeviceErrorMessage(error);
    if (pending) {
      pending.status = "failed";
      pending.error = message;
    }
    log.warn(
      { err: safeErrorMessage(error) },
      "ChatGPT subscription device-code auth failed",
    );
    return {
      mode: "device_code" as const,
      status: "failed" as const,
      callback_listening: false,
      error: message,
      user_code: userCode,
      expires_at: expiresAt,
      started_at: startedAt,
    };
  }
}

async function handleBrowserHeldDeviceStatus(args: RouteHandlerArgs) {
  const params = statusParams(args);
  const deviceCode = params.device_code;
  const userCode = params.user_code;
  const expiresAt = positiveNumber(params.expires_at);
  const startedAt = positiveNumber(params.started_at);

  if (
    typeof deviceCode !== "string" ||
    !deviceCode ||
    typeof userCode !== "string" ||
    !userCode
  ) {
    return {
      status: "expired" as const,
      callback_listening: false,
      error: EXPIRED_AUTH_MESSAGE,
    };
  }

  return await pollAndPersistDeviceStatus({
    deviceCode,
    userCode,
    expiresAt,
    startedAt,
  });
}

async function handleStatus(args: RouteHandlerArgs) {
  cleanupExpiredEntries();
  const params = statusParams(args);
  const state = params.state;
  if (typeof state !== "string" || !state) {
    throw new BadRequestError("state parameter is required");
  }
  const pending = pendingAuths.get(state);
  if (!pending) {
    return await handleBrowserHeldDeviceStatus(args);
  }

  if (pending.mode === "device_code" && pending.status === "pending") {
    if (!pending.deviceCode || !pending.userCode) {
      pending.status = "failed";
      pending.error =
        "This ChatGPT sign-in is missing required device details. Start a fresh ChatGPT sign-in and try again.";
      return {
        mode: "device_code" as const,
        status: "failed" as const,
        callback_listening: false,
        error: pending.error,
      };
    }

    return await pollAndPersistDeviceStatus({
      deviceCode: pending.deviceCode,
      userCode: pending.userCode,
      expiresAt: pending.expiresAt,
      startedAt: pending.createdAt,
      pending,
    });
  }

  return {
    mode: pending.mode,
    status: pending.status,
    callback_listening: pending.callbackListening,
    error: pending.error,
    device_code: pending.deviceCode,
    user_code: pending.userCode,
    verification_uri: pending.verificationUri,
    verification_uri_complete: pending.verificationUriComplete ?? null,
    expires_at: pending.expiresAt,
    started_at: pending.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "inference_chatgpt_subscription_auth",
    endpoint: "inference/chatgpt-subscription/auth",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Start ChatGPT subscription OAuth PKCE flow",
    description:
      "Start ChatGPT subscription auth. The hosted web app uses OpenAI's ChatGPT device-code flow; loopback PKCE remains available only when explicitly requested.",
    tags: ["inference"],
    requestBody: z
      .object({
        transport: z.enum(["device_code", "loopback"]).optional(),
      })
      .optional(),
    responseBody: z.object({
      authorize_url: z.string(),
      state: z.string(),
      mode: z.enum(["device_code", "loopback"]),
      code_verifier: z.string().optional(),
      callback_listening: z.boolean(),
      device_code: z.string().optional(),
      user_code: z.string().optional(),
      verification_uri: z.string().optional(),
      verification_uri_complete: z.string().nullable().optional(),
      expires_at: z.number().optional(),
      expires_in: z.number().optional(),
      started_at: z.number().optional(),
      interval: z.number().optional(),
    }),
    handler: handleStartAuth,
  },
  {
    operationId: "inference_chatgpt_subscription_auth_status",
    endpoint: "inference/chatgpt-subscription/auth/status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Check ChatGPT subscription OAuth status",
    description:
      "Return the pending, exchanging, completed, failed, or expired state for a ChatGPT subscription auth flow.",
    tags: ["inference"],
    queryParams: [
      {
        name: "state",
        type: "string",
        required: true,
        description: "OAuth state returned by the start auth route.",
      },
      {
        name: "device_code",
        type: "string",
        required: false,
        description:
          "Opaque OpenAI device authorization id returned by the start route. Hosted web clients send this so any backend worker can complete the flow.",
      },
      {
        name: "user_code",
        type: "string",
        required: false,
        description:
          "OpenAI user code returned by the start route. Used with device_code for hosted web status polling.",
      },
      {
        name: "expires_at",
        type: "number",
        required: false,
        description:
          "Device-flow expiry timestamp in milliseconds since epoch returned by the start route.",
      },
      {
        name: "started_at",
        type: "number",
        required: false,
        description:
          "Device-flow start timestamp in milliseconds since epoch returned by the start route.",
      },
    ],
    responseBody: z.object({
      mode: z.enum(["device_code", "loopback"]).optional(),
      status: z.enum([
        "pending",
        "exchanging",
        "completed",
        "failed",
        "expired",
      ]),
      callback_listening: z.boolean(),
      error: z.string().optional(),
      device_code: z.string().optional(),
      user_code: z.string().optional(),
      verification_uri: z.string().optional(),
      verification_uri_complete: z.string().nullable().optional(),
      expires_at: z.number().optional(),
      started_at: z.number().optional(),
    }),
    handler: handleStatus,
  },
  {
    operationId: "inference_chatgpt_subscription_auth_status_post",
    endpoint: "inference/chatgpt-subscription/auth/status",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Check ChatGPT subscription OAuth status",
    description:
      "Return the pending, exchanging, completed, failed, or expired state for a ChatGPT subscription auth flow. Hosted web clients use POST so device-code fields stay out of query strings.",
    tags: ["inference"],
    requestBody: z.object({
      state: z.string(),
      device_code: z.string().optional(),
      user_code: z.string().optional(),
      expires_at: z.number().optional(),
      started_at: z.number().optional(),
    }),
    responseBody: z.object({
      mode: z.enum(["device_code", "loopback"]).optional(),
      status: z.enum([
        "pending",
        "exchanging",
        "completed",
        "failed",
        "expired",
      ]),
      callback_listening: z.boolean(),
      error: z.string().optional(),
      device_code: z.string().optional(),
      user_code: z.string().optional(),
      verification_uri: z.string().optional(),
      verification_uri_complete: z.string().nullable().optional(),
      expires_at: z.number().optional(),
      started_at: z.number().optional(),
    }),
    handler: handleStatus,
  },
  {
    operationId: "inference_chatgpt_subscription_auth_exchange",
    endpoint: "inference/chatgpt-subscription/auth/exchange",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Exchange ChatGPT subscription OAuth authorization code",
    description:
      "Accept an authorization code and state from the OAuth redirect, exchange it for tokens, store them in CES, and upsert the provider connection.",
    tags: ["inference"],
    requestBody: z.object({
      code: z.string(),
      state: z.string(),
      code_verifier: z.string().optional(),
    }),
    responseBody: z.object({
      ok: z.boolean(),
    }),
    handler: handleExchange,
  },
];
