import { describe, expect, test } from "bun:test";

import { verifyRetentionActorToken } from "../../retention-service/src/auth.js";
import { mintRetentionServiceToken } from "./retention-service-auth.js";
import type { EnabledRetentionServiceConfig } from "./retention-service-config.js";

const JWT_SECRET = "retention-cross-package-jwt-secret-2026";

const config: EnabledRetentionServiceConfig = {
  enabled: true,
  internalBaseUrl: "http://retention-service.railway.internal/",
  serviceJwtSecret: JWT_SECRET,
  providerWebhookSecret: "retention-webhook-secret-separate-2026",
  tokenTtlSeconds: 30,
  requestTimeoutMs: 5_000,
  maxRequestBodyBytes: 1024 * 1024,
};

describe("control-plane to retention-service token contract", () => {
  test("mints claims the service verifies without tenant reinterpretation", () => {
    const nowMs = Date.parse("2026-07-28T12:00:00.000Z");
    const minted = mintRetentionServiceToken(
      config,
      {
        organizationId: "11111111-1111-4111-8111-111111111111",
        userId: "auth0|customer-1",
        assistantId: "assistant-1",
        roles: [
          "retention_marketer",
          "retention_campaign_approver",
        ],
      },
      nowMs,
    );

    const claims = verifyRetentionActorToken({
      token: minted.token,
      signingKey: Buffer.from(JWT_SECRET, "utf8"),
      issuer: "worklin-control-plane",
      audience: "worklin-retention-service",
      nowMs: nowMs + 1_000,
    });

    expect(claims.organization_id).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(claims.user_id).toBe("auth0|customer-1");
    expect(claims.assistant_id).toBe("assistant-1");
    expect(claims.token_use).toBe("retention_service");
    expect(claims.permissions).toEqual([
      "retention:approve",
      "retention:generate",
      "retention:read",
      "retention:write",
    ]);
  });

  test("rejects a token after its short expiry", () => {
    const nowMs = Date.parse("2026-07-28T12:00:00.000Z");
    const minted = mintRetentionServiceToken(
      config,
      {
        organizationId: "11111111-1111-4111-8111-111111111111",
        userId: "customer-1",
        assistantId: "assistant-1",
        roles: ["retention_viewer"],
      },
      nowMs,
    );

    expect(() =>
      verifyRetentionActorToken({
        token: minted.token,
        signingKey: Buffer.from(JWT_SECRET, "utf8"),
        issuer: "worklin-control-plane",
        audience: "worklin-retention-service",
        nowMs: nowMs + 31_000,
      }),
    ).toThrow("Expired or mis-scoped");
  });
});
