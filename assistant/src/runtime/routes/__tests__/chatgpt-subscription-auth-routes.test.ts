import { beforeEach, describe, expect, mock, test } from "bun:test";

let exchangedCodeVerifier: string | null = null;
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
import { BadRequestError } from "../errors.js";
import { ROUTES } from "../chatgpt-subscription-auth-routes.js";
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
  secureWrites = {};
});

describe("ChatGPT subscription auth routes", () => {
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

  test("route schemas document the browser-held verifier fields", () => {
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

    expect(startShape?.code_verifier).toBeDefined();
    expect(exchangeShape?.code_verifier).toBeDefined();
  });
});
