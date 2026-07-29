import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  deriveManagedOAuthServiceKey,
  ManagedGoogleOAuthService,
  managedGoogleOAuthConfigFromEnv,
  serviceKeyMatches,
} from "./managed-google-oauth.js";

const ENCRYPTION_KEY = "b".repeat(64);
const REDIRECT =
  "https://worklin-ai.vercel.app/account/oauth/popup-complete?requestId=req-1&oauth_provider=google";

function config() {
  return managedGoogleOAuthConfigFromEnv({
    WORKLIN_GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
    WORKLIN_GOOGLE_OAUTH_CLIENT_CREDENTIAL: "google-client-credential",
    WORKLIN_OAUTH_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    WORKLIN_WEB_ORIGIN: "https://worklin-ai.vercel.app",
  });
}

function tenant() {
  return {
    assistantId: "assistant-1",
    organizationId: "organization-1",
    userId: "user-1",
  };
}

describe("managedGoogleOAuthConfigFromEnv", () => {
  test("stays unavailable until every server-side prerequisite exists", () => {
    expect(managedGoogleOAuthConfigFromEnv({}).enabled).toBe(false);
    expect(
      managedGoogleOAuthConfigFromEnv({
        WORKLIN_GOOGLE_OAUTH_CLIENT_ID: "client",
        WORKLIN_GOOGLE_OAUTH_CLIENT_CREDENTIAL: "credential",
        WORKLIN_OAUTH_TOKEN_ENCRYPTION_KEY: "not-a-key",
      }).enabled,
    ).toBe(false);
    expect(config().enabled).toBe(true);
    expect(config().callbackUrl).toBe(
      "https://worklin-ai.vercel.app/v1/oauth/google/callback/",
    );
  });
});

describe("managed OAuth runtime service keys", () => {
  test("are deterministic, assistant-scoped, and timing-safe comparable", () => {
    const runtimeKey = "a".repeat(64);
    const first = deriveManagedOAuthServiceKey(runtimeKey, "assistant-1");
    const repeat = deriveManagedOAuthServiceKey(runtimeKey, "assistant-1");
    const other = deriveManagedOAuthServiceKey(runtimeKey, "assistant-2");

    expect(first).toBe(repeat);
    expect(first).not.toBe(other);
    expect(serviceKeyMatches(first, repeat)).toBe(true);
    expect(serviceKeyMatches(first, other)).toBe(false);
  });
});

describe("ManagedGoogleOAuthService", () => {
  test("completes PKCE authorization, encrypts tokens, and proxies Google requests", async () => {
    const db = new Database(":memory:");
    const upstreamRequests: Array<{
      url: string;
      authorization: string | null;
    }> = [];
    const fetchImpl = (async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      upstreamRequests.push({
        url,
        authorization: headers.get("authorization"),
      });
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({
          access_token: "google-access-token",
          refresh_token: "google-refresh-token",
          expires_in: 3600,
          scope: "openid email https://www.googleapis.com/auth/gmail.modify",
          token_type: "Bearer",
        });
      }
      if (url === "https://www.googleapis.com/oauth2/v2/userinfo") {
        return Response.json({
          id: "google-user-1",
        email: "marketer@example.com",
          verified_email: true,
        });
      }
      if (
        url ===
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5"
      ) {
        return Response.json(
          { messages: [{ id: "message-1" }] },
          { headers: { ETag: "messages-v1" } },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const service = new ManagedGoogleOAuthService(
      db,
      config(),
      fetchImpl,
      () => 1_000,
    );

    const started = service.start({
      tenant: tenant(),
      redirectAfterConnect: REDIRECT,
    });
    const authorizationUrl = new URL(started.connect_url);
    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorizationUrl.searchParams.get("access_type")).toBe("offline");
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    const callback = await service.complete({
      state: state!,
      code: "authorization-code",
    });
    expect(callback).toContain("oauth_status=connected");

    const connections = service.list({
      assistantId: tenant().assistantId,
      userId: tenant().userId,
      provider: "google",
      status: "ACTIVE",
    });
    expect(connections).toEqual([
      expect.objectContaining({
        provider: "google",
        status: "ACTIVE",
        connected: true,
      account_label: "marketer@example.com",
      }),
    ]);

    const stored = db
      .query<
        {
          access_token_ciphertext: string;
          refresh_token_ciphertext: string;
        },
        []
      >(
        `SELECT access_token_ciphertext, refresh_token_ciphertext
         FROM managed_oauth_connections`,
      )
      .get();
    expect(stored?.access_token_ciphertext).not.toContain(
      "google-access-token",
    );
    expect(stored?.refresh_token_ciphertext).not.toContain(
      "google-refresh-token",
    );

    const proxied = await service.proxy(
      tenant().assistantId,
      connections[0]!.id,
      {
        request: {
          method: "GET",
          base_url: "https://gmail.googleapis.com/gmail/v1/users/me",
          path: "/messages",
          query: { maxResults: 5 },
          headers: { Authorization: "Bearer attacker-token" },
          body: null,
        },
      },
    );
    expect(proxied).toEqual({
      ok: true,
      status: 200,
      headers: {
        "content-type": "application/json;charset=utf-8",
        etag: "messages-v1",
      },
      body: { messages: [{ id: "message-1" }] },
    });
    expect(upstreamRequests.at(-1)).toEqual({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5",
      authorization: "Bearer google-access-token",
    });

    db.close();
  });

  test("consumes OAuth state once and rejects unsafe redirects", async () => {
    const db = new Database(":memory:");
    const service = new ManagedGoogleOAuthService(db, config());

    expect(() =>
      service.start({
        tenant: tenant(),
        redirectAfterConnect: "https://attacker.example/callback",
      }),
    ).toThrow("not allowed");

    const started = service.start({
      tenant: tenant(),
      redirectAfterConnect: REDIRECT,
    });
    const state = new URL(started.connect_url).searchParams.get("state")!;
    const denied = await service.complete({
      state,
      providerError: "access_denied",
    });
    expect(denied).toContain("oauth_status=denied");
    expect(await service.complete({ state, code: "replayed-code" })).toBeNull();

    db.close();
  });

  test("blocks proxy requests from escaping the Google API allowlist", async () => {
    const db = new Database(":memory:");
    let fetchCalls = 0;
    const fetchImpl = (async (input) => {
      fetchCalls += 1;
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
        });
      }
      if (url === "https://www.googleapis.com/oauth2/v2/userinfo") {
        return Response.json({ email: "user@example.com" });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const service = new ManagedGoogleOAuthService(
      db,
      config(),
      fetchImpl,
      () => 1_000,
    );
    const started = service.start({
      tenant: tenant(),
      redirectAfterConnect: REDIRECT,
    });
    await service.complete({
      state: new URL(started.connect_url).searchParams.get("state")!,
      code: "code",
    });
    const connection = service.list({
      assistantId: tenant().assistantId,
      userId: tenant().userId,
    })[0]!;
    const callsBeforeProxy = fetchCalls;
    const result = await service.proxy(tenant().assistantId, connection.id, {
      request: {
        method: "GET",
        base_url: "https://attacker.example",
        path: "/steal",
      },
    });
    expect(result).toEqual({
      ok: false,
      status: 403,
      detail: "Google request address is not allowed.",
    });
    expect(fetchCalls).toBe(callsBeforeProxy);

    db.close();
  });
});
