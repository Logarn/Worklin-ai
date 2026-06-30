import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock logger and token exchange before importing the code under test.
// ---------------------------------------------------------------------------

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

let exchangedCode: string | null = null;
let exchangedRedirectUri: string | null = null;
let exchangedCodeVerifier: string | null = null;
let exchangedConfig: Record<string, unknown> | null = null;

mock.module("../oauth2.js", () => ({
  exchangeCodeForTokens: async (
    config: Record<string, unknown>,
    code: string,
    redirectUri: string,
    codeVerifier: string,
  ) => {
    exchangedConfig = config;
    exchangedCode = code;
    exchangedRedirectUri = redirectUri;
    exchangedCodeVerifier = codeVerifier;
    return {
      tokens: {
        accessToken: "at-from-exchange",
        refreshToken: "rt-from-exchange",
        expiresIn: 3600,
        tokenType: "Bearer",
        scope: "openid profile",
      },
      grantedScopes: [],
      rawTokenResponse: {},
    };
  },
}));

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import type { DeviceCodeConfig } from "../oauth2-device-code.js";
import {
  DeviceCodeError,
  OPENAI_DEVICE_CODE_CONFIG,
  pollForToken,
  requestDeviceCode,
  startDeviceCodeFlow,
} from "../oauth2-device-code.js";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = handler as typeof globalThis.fetch;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TEST_CONFIG: DeviceCodeConfig = {
  issuerUrl: "https://auth.example.com",
  deviceCodeUrl: "https://auth.example.com/api/accounts/deviceauth/usercode",
  tokenUrl: "https://auth.example.com/api/accounts/deviceauth/token",
  tokenExchangeUrl: "https://auth.example.com/oauth/token",
  clientId: "test-client-id",
  scopes: ["openid", "profile"],
  scopeSeparator: " ",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("oauth2-device-code", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
    exchangedCode = null;
    exchangedRedirectUri = null;
    exchangedCodeVerifier = null;
    exchangedConfig = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("OPENAI_DEVICE_CODE_CONFIG", () => {
    test("has the expected OpenAI Codex values", () => {
      expect(OPENAI_DEVICE_CODE_CONFIG.issuerUrl).toBe(
        "https://auth.openai.com",
      );
      expect(OPENAI_DEVICE_CODE_CONFIG.deviceCodeUrl).toBe(
        "https://auth.openai.com/api/accounts/deviceauth/usercode",
      );
      expect(OPENAI_DEVICE_CODE_CONFIG.tokenUrl).toBe(
        "https://auth.openai.com/api/accounts/deviceauth/token",
      );
      expect(OPENAI_DEVICE_CODE_CONFIG.tokenExchangeUrl).toBe(
        "https://auth.openai.com/oauth/token",
      );
      expect(OPENAI_DEVICE_CODE_CONFIG.clientId).toBe(
        "app_EMoamEEZ73f0CkXaXp7hrann",
      );
      expect(OPENAI_DEVICE_CODE_CONFIG.scopes).toEqual([
        "openid",
        "profile",
        "email",
        "offline_access",
      ]);
    });
  });

  describe("requestDeviceCode", () => {
    test("sends Codex user-code request and parses response", async () => {
      let capturedUrl = "";
      let capturedBody = "";
      let capturedContentType = "";

      mockFetch(async (url, init) => {
        capturedUrl = url;
        capturedBody = init?.body?.toString() ?? "";
        capturedContentType =
          new Headers(init?.headers).get("Content-Type") ?? "";
        return jsonResponse({
          device_auth_id: "dev-auth-123",
          user_code: "ABCD-1234",
          interval: 5,
        });
      });

      const result = await requestDeviceCode(TEST_CONFIG);

      expect(capturedUrl).toBe(TEST_CONFIG.deviceCodeUrl);
      expect(capturedContentType).toBe("application/json");
      expect(JSON.parse(capturedBody)).toEqual({
        client_id: "test-client-id",
      });

      expect(result.deviceCode).toBe("dev-auth-123");
      expect(result.userCode).toBe("ABCD-1234");
      expect(result.verificationUri).toBe(
        "https://auth.example.com/codex/device",
      );
      expect(result.verificationUriComplete).toBeUndefined();
      expect(result.expiresIn).toBe(900);
      expect(result.interval).toBe(5);
    });

    test("accepts string interval and explicit verification URI", async () => {
      mockFetch(async () =>
        jsonResponse({
          device_auth_id: "dev-auth-123",
          user_code: "ABCD-1234",
          verification_uri: "https://auth.example.com/custom-device",
          verification_uri_complete: "https://auth.example.com/custom-device",
          expires_in: "120",
          interval: "7",
        }),
      );

      const result = await requestDeviceCode(TEST_CONFIG);
      expect(result.verificationUri).toBe(
        "https://auth.example.com/custom-device",
      );
      expect(result.verificationUriComplete).toBe(
        "https://auth.example.com/custom-device",
      );
      expect(result.expiresIn).toBe(120);
      expect(result.interval).toBe(7);
    });

    test("throws DeviceCodeError on non-OK response", async () => {
      mockFetch(async () => jsonResponse({ error: "invalid_client" }, 400));

      try {
        await requestDeviceCode(TEST_CONFIG);
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceCodeError);
        expect((err as DeviceCodeError).code).toBe("request_failed");
      }
    });

    test("throws DeviceCodeError when required response fields are missing", async () => {
      mockFetch(async () => jsonResponse({ user_code: "ABCD-1234" }));

      try {
        await requestDeviceCode(TEST_CONFIG);
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceCodeError);
        expect((err as DeviceCodeError).code).toBe("request_failed");
      }
    });
  });

  describe("pollForToken", () => {
    test("exchanges authorization code on immediate success", async () => {
      let capturedUrl = "";
      let capturedBody = "";

      mockFetch(async (url, init) => {
        capturedUrl = url;
        capturedBody = init?.body?.toString() ?? "";
        return jsonResponse({
          authorization_code: "auth-code-123",
          code_verifier: "verifier-456",
          code_challenge: "challenge-789",
        });
      });

      const result = await pollForToken(
        TEST_CONFIG,
        "dev-auth-123",
        "ABCD-1234",
        1,
        30,
      );

      expect(capturedUrl).toBe(TEST_CONFIG.tokenUrl);
      expect(JSON.parse(capturedBody)).toEqual({
        device_auth_id: "dev-auth-123",
        user_code: "ABCD-1234",
      });
      expect(exchangedCode).toBe("auth-code-123");
      expect(exchangedCodeVerifier).toBe("verifier-456");
      expect(exchangedRedirectUri).toBe(
        "https://auth.example.com/deviceauth/callback",
      );
      expect(exchangedConfig?.tokenExchangeUrl).toBe(
        "https://auth.example.com/oauth/token",
      );
      expect(result.accessToken).toBe("at-from-exchange");
      expect(result.refreshToken).toBe("rt-from-exchange");
    });

    test("polls through 403 and 404 pending statuses then succeeds", async () => {
      let callCount = 0;
      const sleepDelays: number[] = [];

      mockFetch(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response("", { status: 403 });
        }
        if (callCount === 2) {
          return new Response("", { status: 404 });
        }
        return jsonResponse({
          authorization_code: "auth-code-after-pending",
          code_verifier: "verifier-after-pending",
        });
      });

      const result = await pollForToken(
        TEST_CONFIG,
        "dev-auth-123",
        "ABCD-1234",
        1,
        30,
        undefined,
        async (ms) => {
          sleepDelays.push(ms);
        },
      );

      expect(result.accessToken).toBe("at-from-exchange");
      expect(exchangedCode).toBe("auth-code-after-pending");
      expect(callCount).toBe(3);
      expect(sleepDelays).toEqual([1000, 1000]);
    });

    test("increases interval on slow_down", async () => {
      let callCount = 0;
      const sleepDelays: number[] = [];

      mockFetch(async () => {
        callCount++;
        if (callCount === 1) {
          return jsonResponse({ error: "slow_down" }, 400);
        }
        return jsonResponse({
          authorization_code: "auth-code-slow",
          code_verifier: "verifier-slow",
        });
      });

      const result = await pollForToken(
        TEST_CONFIG,
        "dev-auth-123",
        "ABCD-1234",
        2,
        60,
        undefined,
        async (ms) => {
          sleepDelays.push(ms);
        },
      );

      expect(result.accessToken).toBe("at-from-exchange");
      expect(callCount).toBe(2);
      expect(sleepDelays).toEqual([7000]);
    });

    test("throws on expired_token", async () => {
      mockFetch(async () => jsonResponse({ error: "expired_token" }, 400));

      try {
        await pollForToken(TEST_CONFIG, "dev-auth-123", "ABCD-1234", 1, 30);
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceCodeError);
        expect((err as DeviceCodeError).code).toBe("expired_token");
      }
    });

    test("throws on access_denied", async () => {
      mockFetch(async () => jsonResponse({ error: "access_denied" }, 400));

      try {
        await pollForToken(TEST_CONFIG, "dev-auth-123", "ABCD-1234", 1, 30);
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceCodeError);
        expect((err as DeviceCodeError).code).toBe("access_denied");
      }
    });

    test("throws on abort signal", async () => {
      const ac = new AbortController();
      ac.abort();

      try {
        await pollForToken(
          TEST_CONFIG,
          "dev-auth-123",
          "ABCD-1234",
          1,
          30,
          ac.signal,
        );
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceCodeError);
        expect((err as DeviceCodeError).code).toBe("aborted");
      }
    });

    test("aborts mid-poll when signal fires", async () => {
      const ac = new AbortController();

      mockFetch(async () => {
        ac.abort();
        return new Response("", { status: 403 });
      });

      try {
        await pollForToken(
          TEST_CONFIG,
          "dev-auth-123",
          "ABCD-1234",
          1,
          30,
          ac.signal,
        );
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceCodeError);
        expect((err as DeviceCodeError).code).toBe("aborted");
      }
    });

    test("throws on unexpected error code", async () => {
      mockFetch(async () => jsonResponse({ error: "server_error" }, 500));

      try {
        await pollForToken(TEST_CONFIG, "dev-auth-123", "ABCD-1234", 1, 30);
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceCodeError);
        expect((err as DeviceCodeError).code).toBe("request_failed");
      }
    });

    test("retries on network error then succeeds", async () => {
      let callCount = 0;
      const sleepDelays: number[] = [];

      mockFetch(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("Network error");
        }
        return jsonResponse({
          authorization_code: "auth-code-retry",
          code_verifier: "verifier-retry",
        });
      });

      const result = await pollForToken(
        TEST_CONFIG,
        "dev-auth-123",
        "ABCD-1234",
        1,
        30,
        undefined,
        async (ms) => {
          sleepDelays.push(ms);
        },
      );

      expect(result.accessToken).toBe("at-from-exchange");
      expect(callCount).toBe(2);
      expect(sleepDelays).toEqual([1000]);
    });

    test("times out while approval remains pending", async () => {
      mockFetch(async () => new Response("", { status: 403 }));

      try {
        await pollForToken(
          TEST_CONFIG,
          "dev-auth-123",
          "ABCD-1234",
          1,
          2,
          undefined,
          async () => {},
        );
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceCodeError);
        expect((err as DeviceCodeError).code).toBe("expired_token");
      }
    });
  });

  describe("startDeviceCodeFlow", () => {
    test("runs full flow: user-code request, device poll, token exchange", async () => {
      let callCount = 0;

      mockFetch(async (url) => {
        callCount++;
        if (url === TEST_CONFIG.deviceCodeUrl) {
          return jsonResponse({
            device_auth_id: "full-flow-auth",
            user_code: "FULL-1234",
            interval: 0.01,
          });
        }
        if (callCount === 2) {
          return new Response("", { status: 403 });
        }
        return jsonResponse({
          authorization_code: "auth-code-full-flow",
          code_verifier: "verifier-full-flow",
        });
      });

      const result = await startDeviceCodeFlow(TEST_CONFIG);

      expect(result.init.deviceCode).toBe("full-flow-auth");
      expect(result.init.userCode).toBe("FULL-1234");
      expect(result.init.verificationUri).toBe(
        "https://auth.example.com/codex/device",
      );
      expect(result.tokens.accessToken).toBe("at-from-exchange");
      expect(exchangedCode).toBe("auth-code-full-flow");
    });

    test("propagates abort signal to poll", async () => {
      const ac = new AbortController();

      mockFetch(async (url) => {
        if (url === TEST_CONFIG.deviceCodeUrl) {
          return jsonResponse({
            device_auth_id: "abort-auth",
            user_code: "ABRT-1234",
            interval: 0.01,
          });
        }
        ac.abort();
        return new Response("", { status: 403 });
      });

      try {
        await startDeviceCodeFlow(TEST_CONFIG, ac.signal);
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceCodeError);
        expect((err as DeviceCodeError).code).toBe("aborted");
      }
    });
  });
});
