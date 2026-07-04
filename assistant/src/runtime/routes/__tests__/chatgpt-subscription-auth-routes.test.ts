import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let exchangedCodeVerifier: string | null = null;
let requestedDeviceCode = false;
let polledDeviceCode: string | null = null;
let polledUserCode: string | null = null;
let devicePollError: Error | null = null;
let devicePollMode: "success" | "pending" = "success";
let deviceExpiresIn = 900;
let secureWrites: Record<string, string> = {};
let failingSecureAccounts = new Set<string>();
let bulkOnlyFailingSecureAccounts = new Set<string>();
const realDateNow = Date.now;

mock.module("../../../security/oauth2.js", () => ({
  exchangeCodeForTokens: async (
    _config: unknown,
    _code: string,
    _redirectUri: string,
    codeVerifier: string,
  ) => {
    exchangedCodeVerifier = codeVerifier;
    return {
      tokens: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresIn: 3600,
      },
      grantedScopes: [],
      rawTokenResponse: {},
    };
  },
  generateCodeChallenge: (verifier: string) => `challenge-${verifier}`,
  generateCodeVerifier: () => "a".repeat(43),
  generateState: () => "state-123",
}));

mock.module("../../../security/oauth2-device-code.js", () => {
  class MockDeviceCodeError extends Error {
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

  return {
    DeviceCodeError: MockDeviceCodeError,
    OPENAI_DEVICE_CODE_CONFIG: {
      issuerUrl: "https://auth.openai.com",
      deviceCodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
      tokenUrl: "https://auth.openai.com/api/accounts/deviceauth/token",
      tokenExchangeUrl: "https://auth.openai.com/oauth/token",
      clientId: "client-id",
      scopes: ["openid", "profile", "email", "offline_access"],
      scopeSeparator: " ",
    },
    requestDeviceCode: async () => {
      requestedDeviceCode = true;
      return {
        deviceCode: "device-code-123",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.openai.com/codex/device",
        expiresIn: deviceExpiresIn,
        interval: 1,
      };
    },
    pollForToken: async (
      _config: unknown,
      deviceCode: string,
      userCode: string,
    ) => {
      polledDeviceCode = deviceCode;
      polledUserCode = userCode;
      if (devicePollError) {
        throw devicePollError;
      }
      if (devicePollMode === "pending") {
        return await new Promise<never>(() => {});
      }
      return {
        accessToken: "device-access-token",
        refreshToken: "device-refresh-token",
        expiresIn: 3600,
      };
    },
    pollForTokenOnce: async (
      _config: unknown,
      deviceCode: string,
      userCode: string,
    ) => {
      polledDeviceCode = deviceCode;
      polledUserCode = userCode;
      if (devicePollError) {
        throw devicePollError;
      }
      if (devicePollMode === "pending") {
        return { status: "pending" };
      }
      return {
        status: "token",
        tokens: {
          accessToken: "device-access-token",
          refreshToken: "device-refresh-token",
          expiresIn: 3600,
        },
      };
    },
  };
});

mock.module("../../../security/secure-keys.js", () => ({
  bulkSetSecureKeysAsync: async (
    credentials: Array<{ account: string; value: string }>,
  ) =>
    credentials.map(({ account, value }) => {
      if (
        failingSecureAccounts.has(account) ||
        bulkOnlyFailingSecureAccounts.has(account)
      ) {
        return { account, ok: false };
      }
      secureWrites[account] = value;
      return { account, ok: true };
    }),
  setSecureKeyAsync: async (account: string, value: string) => {
    if (failingSecureAccounts.has(account)) {
      return false;
    }
    secureWrites[account] = value;
    return true;
  },
  getActiveBackendName: () => "test-backend",
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

import { getDb } from "../../../memory/db-connection.js";
import { initializeDb } from "../../../memory/db-init.js";
import { providerConnections } from "../../../memory/schema/inference.js";
import { getConnection } from "../../../providers/inference/connections.js";
import { ROUTES } from "../chatgpt-subscription-auth-routes.js";
import { BadRequestError } from "../errors.js";
import type { RouteDefinition } from "../types.js";

initializeDb();

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

beforeEach(() => {
  getDb().delete(providerConnections).run();
  exchangedCodeVerifier = null;
  requestedDeviceCode = false;
  polledDeviceCode = null;
  polledUserCode = null;
  devicePollError = null;
  devicePollMode = "success";
  deviceExpiresIn = 900;
  secureWrites = {};
  failingSecureAccounts = new Set<string>();
  bulkOnlyFailingSecureAccounts = new Set<string>();
  Date.now = realDateNow;
});

afterEach(() => {
  Date.now = realDateNow;
});

describe("ChatGPT subscription auth routes", () => {
  test("starts hosted web auth with a device code and completes after approval", async () => {
    const result = (await findHandler("inference_chatgpt_subscription_auth")({
      body: {},
    })) as Record<string, unknown>;

    expect(typeof result.expires_at).toBe("number");
    expect(typeof result.started_at).toBe("number");
    expect(result).toMatchObject({
      authorize_url: "https://auth.openai.com/codex/device",
      state: "state-123",
      mode: "device_code",
      callback_listening: false,
      device_code: "device-code-123",
      user_code: "ABCD-EFGH",
      verification_uri: "https://auth.openai.com/codex/device",
      verification_uri_complete: null,
      expires_in: 900,
      interval: 1,
    });
    expect(requestedDeviceCode).toBe(true);
    expect(polledDeviceCode).toBe(null);
    expect(polledUserCode).toBe(null);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const status = await findHandler(
      "inference_chatgpt_subscription_auth_status",
    )({
      queryParams: { state: "state-123" },
    });
    expect(status).toMatchObject({
      mode: "device_code",
      status: "completed",
      callback_listening: false,
    });
    expect(polledDeviceCode).toBe("device-code-123");
    expect(polledUserCode).toBe("ABCD-EFGH");
    expect(secureWrites["credential/chatgpt/access_token"]).toBe(
      "device-access-token",
    );

    const connection = getConnection(getDb(), "chatgpt-subscription");
    expect(connection?.auth).toEqual({
      type: "oauth_subscription",
      credential: "credential/chatgpt/access_token",
    });
  });

  test("device-code status stays completed after a duplicate redemption response", async () => {
    const startedAt = realDateNow();
    Date.now = () => startedAt;

    await findHandler("inference_chatgpt_subscription_auth_status")({
      queryParams: {
        state: "state-from-another-worker",
        device_code: "device-code-123",
        user_code: "ABCD-EFGH",
        expires_at: String(startedAt + 15 * 60 * 1000),
        started_at: String(startedAt),
      },
    });

    const { DeviceCodeError } =
      await import("../../../security/oauth2-device-code.js");
    devicePollError = new DeviceCodeError(
      "Token poll failed: invalid_grant (Device code already redeemed)",
      "request_failed",
    );

    const duplicateStatus = await findHandler(
      "inference_chatgpt_subscription_auth_status",
    )({
      queryParams: {
        state: "state-from-another-worker",
        device_code: "device-code-123",
        user_code: "ABCD-EFGH",
        expires_at: String(startedAt + 15 * 60 * 1000),
        started_at: String(startedAt),
      },
    });

    expect(duplicateStatus).toMatchObject({
      mode: "device_code",
      status: "completed",
      callback_listening: false,
    });
  });

  test("device-code duplicate fallback ignores stale persisted connections", async () => {
    const startedAt = realDateNow() + 60_000;
    const staleConnectionAt = startedAt - 10_000;
    getDb()
      .insert(providerConnections)
      .values({
        name: "chatgpt-subscription",
        provider: "openai",
        auth: JSON.stringify({
          type: "oauth_subscription",
          credential: "credential/chatgpt/access_token",
        }),
        label: "ChatGPT subscription",
        baseUrl: null,
        models: null,
        createdAt: staleConnectionAt,
        updatedAt: staleConnectionAt,
      })
      .run();

    Date.now = () => startedAt;

    const { DeviceCodeError } =
      await import("../../../security/oauth2-device-code.js");
    devicePollError = new DeviceCodeError(
      "Token poll failed: invalid_grant (Device code already redeemed)",
      "request_failed",
    );

    const status = await findHandler(
      "inference_chatgpt_subscription_auth_status",
    )({
      queryParams: {
        state: "state-from-another-worker",
        device_code: "device-code-123",
        user_code: "ABCD-EFGH",
        expires_at: String(startedAt + 15 * 60 * 1000),
        started_at: String(startedAt),
      },
    });

    expect(status).toMatchObject({
      mode: "device_code",
      status: "failed",
      callback_listening: false,
      error: "Token poll failed: invalid_grant (Device code already redeemed)",
    });
  });

  test("device-code status can complete when server state lives on another worker", async () => {
    const startedAt = realDateNow();
    Date.now = () => startedAt;

    const status = await findHandler(
      "inference_chatgpt_subscription_auth_status",
    )({
      queryParams: {
        state: "state-from-another-worker",
        device_code: "device-code-123",
        user_code: "ABCD-EFGH",
        expires_at: String(startedAt + 15 * 60 * 1000),
        started_at: String(startedAt),
      },
    });

    expect(status).toMatchObject({
      mode: "device_code",
      status: "completed",
      callback_listening: false,
      user_code: "ABCD-EFGH",
    });
    expect(polledDeviceCode).toBe("device-code-123");
    expect(polledUserCode).toBe("ABCD-EFGH");
    expect(secureWrites["credential/chatgpt/access_token"]).toBe(
      "device-access-token",
    );

    const connection = getConnection(getDb(), "chatgpt-subscription");
    expect(connection?.auth).toEqual({
      type: "oauth_subscription",
      credential: "credential/chatgpt/access_token",
    });
  });

  test("device-code status reports provider poll failure details", async () => {
    const { DeviceCodeError } =
      await import("../../../security/oauth2-device-code.js");
    devicePollError = new DeviceCodeError(
      "Token poll failed: invalid_request (User code was not approved)",
      "request_failed",
    );

    await findHandler("inference_chatgpt_subscription_auth")({
      body: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const status = await findHandler(
      "inference_chatgpt_subscription_auth_status",
    )({
      queryParams: { state: "state-123" },
    });

    expect(status).toMatchObject({
      mode: "device_code",
      status: "failed",
      callback_listening: false,
      error: "Token poll failed: invalid_request (User code was not approved)",
    });
  });

  test("keeps pending device-code auth until the provider expiry", async () => {
    const startedAt = realDateNow();
    Date.now = () => startedAt;
    deviceExpiresIn = 15 * 60;
    devicePollMode = "pending";

    await findHandler("inference_chatgpt_subscription_auth")({
      body: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    Date.now = () => startedAt + 11 * 60 * 1000;
    const status = await findHandler(
      "inference_chatgpt_subscription_auth_status",
    )({
      queryParams: { state: "state-123" },
    });

    expect(status).toMatchObject({
      mode: "device_code",
      status: "pending",
      callback_listening: false,
    });
  });

  test("expired device-code status includes a useful error message", async () => {
    const startedAt = realDateNow();
    Date.now = () => startedAt;
    deviceExpiresIn = 15 * 60;
    devicePollMode = "pending";

    await findHandler("inference_chatgpt_subscription_auth")({
      body: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    Date.now = () => startedAt + 16 * 60 * 1000;
    const status = await findHandler(
      "inference_chatgpt_subscription_auth_status",
    )({
      queryParams: { state: "state-123" },
    });

    expect(status).toMatchObject({
      status: "expired",
      callback_listening: false,
      error:
        "This ChatGPT sign-in expired before Worklin could finish it. Start a fresh ChatGPT sign-in and try again.",
    });
  });

  test("manual exchange accepts a browser-held PKCE verifier when server state is absent", async () => {
    const verifier = "b".repeat(43);

    const result = await findHandler(
      "inference_chatgpt_subscription_auth_exchange",
    )({
      body: {
        code: "oauth-code",
        state: "state-from-another-instance",
        code_verifier: verifier,
      },
    });

    expect(result).toEqual({ ok: true });
    expect(exchangedCodeVerifier).toBe(verifier);
    expect(secureWrites["credential/chatgpt/access_token"]).toBe(
      "access-token",
    );
    expect(secureWrites["credential/chatgpt/refresh_token"]).toBe(
      "refresh-token",
    );

    const connection = getConnection(getDb(), "chatgpt-subscription");
    expect(connection?.auth).toEqual({
      type: "oauth_subscription",
      credential: "credential/chatgpt/access_token",
    });
  });

  test("manual exchange retries individual credential writes when bulk storage fails", async () => {
    bulkOnlyFailingSecureAccounts = new Set([
      "credential/chatgpt/access_token",
      "credential/chatgpt/refresh_token",
      "credential/chatgpt/expires_at",
    ]);

    const result = await findHandler(
      "inference_chatgpt_subscription_auth_exchange",
    )({
      body: {
        code: "oauth-code",
        state: "state-from-another-instance",
        code_verifier: "b".repeat(43),
      },
    });

    expect(result).toEqual({ ok: true });
    expect(secureWrites["credential/chatgpt/access_token"]).toBe(
      "access-token",
    );
    expect(secureWrites["credential/chatgpt/refresh_token"]).toBe(
      "refresh-token",
    );

    const connection = getConnection(getDb(), "chatgpt-subscription");
    expect(connection?.auth).toEqual({
      type: "oauth_subscription",
      credential: "credential/chatgpt/access_token",
    });
  });

  test("manual exchange repairs a stale malformed provider connection row", async () => {
    getDb()
      .insert(providerConnections)
      .values({
        name: "chatgpt-subscription",
        provider: "openai",
        auth: JSON.stringify({
          type: "chatgpt_subscription",
          credential: "credential/chatgpt/access_token",
        }),
        label: "Old ChatGPT row",
        baseUrl: null,
        models: null,
        createdAt: 100,
        updatedAt: 100,
      })
      .run();

    const result = await findHandler(
      "inference_chatgpt_subscription_auth_exchange",
    )({
      body: {
        code: "oauth-code",
        state: "state-from-another-instance",
        code_verifier: "b".repeat(43),
      },
    });

    expect(result).toEqual({ ok: true });
    const connection = getConnection(getDb(), "chatgpt-subscription");
    expect(connection?.auth).toEqual({
      type: "oauth_subscription",
      credential: "credential/chatgpt/access_token",
    });
    expect(connection?.label).toBe("ChatGPT Subscription");
    expect(connection?.createdAt).toBe(100);
    expect(connection?.updatedAt).toBeGreaterThan(100);
  });

  test("manual exchange reports backend detail when credential storage fails", async () => {
    failingSecureAccounts = new Set(["credential/chatgpt/access_token"]);

    await expect(
      findHandler("inference_chatgpt_subscription_auth_exchange")({
        body: {
          code: "oauth-code",
          state: "state-from-another-instance",
          code_verifier: "b".repeat(43),
        },
      }),
    ).rejects.toThrow(
      "Failed to store ChatGPT credentials (failed: credential/chatgpt/access_token; backend: test-backend)",
    );
  });

  test("manual exchange rejects lost state when the browser verifier is missing", async () => {
    await expect(
      findHandler("inference_chatgpt_subscription_auth_exchange")({
        body: {
          code: "oauth-code",
          state: "missing-state",
        },
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("route schemas document device-code and browser-held verifier fields", () => {
    const startRoute = ROUTES.find(
      (route) => route.operationId === "inference_chatgpt_subscription_auth",
    );
    const statusPostRoute = ROUTES.find(
      (route) =>
        route.operationId === "inference_chatgpt_subscription_auth_status_post",
    );
    const exchangeRoute = ROUTES.find(
      (route) =>
        route.operationId === "inference_chatgpt_subscription_auth_exchange",
    );

    const startShape = (
      startRoute?.responseBody as { shape?: Record<string, unknown> }
    )?.shape;
    const exchangeShape = (
      exchangeRoute?.requestBody as { shape?: Record<string, unknown> }
    )?.shape;
    const statusPostShape = (
      statusPostRoute?.requestBody as { shape?: Record<string, unknown> }
    )?.shape;

    expect(startShape?.mode).toBeDefined();
    expect(startShape?.code_verifier).toBeDefined();
    expect(startShape?.device_code).toBeDefined();
    expect(startShape?.user_code).toBeDefined();
    expect(startShape?.expires_at).toBeDefined();
    expect(startShape?.started_at).toBeDefined();
    expect(startShape?.verification_uri_complete).toBeDefined();
    expect(statusPostShape?.device_code).toBeDefined();
    expect(statusPostShape?.started_at).toBeDefined();
    expect(exchangeShape?.code_verifier).toBeDefined();
  });
});
