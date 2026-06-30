import { beforeEach, describe, expect, mock, test } from "bun:test";

let exchangedCodeVerifier: string | null = null;
let requestedDeviceCode = false;
let polledDeviceCode: string | null = null;
let secureWrites: Record<string, string> = {};

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
      deviceCodeUrl: "https://auth.openai.com/oauth/device/code",
      tokenUrl: "https://auth.openai.com/oauth/token",
      clientId: "client-id",
      scopes: ["openid", "profile", "email", "offline_access"],
      audience: "https://chatgpt.com",
    },
    requestDeviceCode: async () => {
      requestedDeviceCode = true;
      return {
        deviceCode: "device-code-123",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.openai.com/activate",
        verificationUriComplete:
          "https://auth.openai.com/activate?user_code=ABCD-EFGH",
        expiresIn: 900,
        interval: 1,
      };
    },
    pollForToken: async (_config: unknown, deviceCode: string) => {
      polledDeviceCode = deviceCode;
      return {
        accessToken: "device-access-token",
        refreshToken: "device-refresh-token",
        expiresIn: 3600,
      };
    },
  };
});

mock.module("../../../security/secure-keys.js", () => ({
  setSecureKeyAsync: async (key: string, value: string) => {
    secureWrites[key] = value;
    return true;
  },
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
  secureWrites = {};
});

describe("ChatGPT subscription auth routes", () => {
  test("starts hosted web auth with a device code and completes after approval", async () => {
    const result = await findHandler("inference_chatgpt_subscription_auth")({
      body: {},
    });

    expect(result).toMatchObject({
      authorize_url: "https://auth.openai.com/activate?user_code=ABCD-EFGH",
      state: "state-123",
      mode: "device_code",
      callback_listening: false,
      user_code: "ABCD-EFGH",
      verification_uri: "https://auth.openai.com/activate",
      verification_uri_complete:
        "https://auth.openai.com/activate?user_code=ABCD-EFGH",
      expires_in: 900,
      interval: 1,
    });
    expect(requestedDeviceCode).toBe(true);
    expect(polledDeviceCode).toBe("device-code-123");

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
    expect(secureWrites["credential/chatgpt/access_token"]).toBe(
      "device-access-token",
    );

    const connection = getConnection(getDb(), "chatgpt-subscription");
    expect(connection?.auth).toEqual({
      type: "oauth_subscription",
      credential: "credential/chatgpt/access_token",
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

    expect(startShape?.mode).toBeDefined();
    expect(startShape?.code_verifier).toBeDefined();
    expect(startShape?.user_code).toBeDefined();
    expect(startShape?.verification_uri_complete).toBeDefined();
    expect(exchangeShape?.code_verifier).toBeDefined();
  });
});
