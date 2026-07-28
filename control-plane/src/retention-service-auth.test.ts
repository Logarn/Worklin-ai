import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  mintRetentionServiceToken,
  type RetentionServicePrincipal,
} from "./retention-service-auth.js";
import type { EnabledRetentionServiceConfig } from "./retention-service-config.js";

const CONFIG: EnabledRetentionServiceConfig = {
  enabled: true,
  internalBaseUrl: "http://retention-service.internal/",
  serviceJwtSecret: "jwt-secret-".padEnd(40, "a"),
  providerWebhookSecret: "webhook-secret-".padEnd(40, "b"),
  tokenTtlSeconds: 30,
  requestTimeoutMs: 5_000,
  maxRequestBodyBytes: 4_096,
};
const PRINCIPAL: RetentionServicePrincipal = {
  organizationId: "org-123",
  userId: "user-123",
  assistantId: "assistant-123",
  roles: ["retention_campaign_approver", "retention_marketer"],
};

function decodeToken(token: string): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signature: string;
  signingInput: string;
} {
  const [header, payload, signature] = token.split(".");
  return {
    header: JSON.parse(
      Buffer.from(header!, "base64url").toString("utf8"),
    ) as Record<string, unknown>,
    claims: JSON.parse(
      Buffer.from(payload!, "base64url").toString("utf8"),
    ) as Record<string, unknown>,
    signature: signature!,
    signingInput: `${header}.${payload}`,
  };
}

describe("retention service tokens", () => {
  test("binds tenant identity and derived role permissions in an HS256 JWT", () => {
    const minted = mintRetentionServiceToken(CONFIG, PRINCIPAL, 10_000);
    const decoded = decodeToken(minted.token);

    expect(decoded.header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(decoded.claims).toMatchObject({
      iss: "worklin-control-plane",
      aud: "worklin-retention-service",
      sub: "user:user-123",
      token_use: "retention_service",
      organization_id: "org-123",
      user_id: "user-123",
      assistant_id: "assistant-123",
      roles: ["retention_campaign_approver", "retention_marketer"],
      permissions: [
        "retention:approve",
        "retention:generate",
        "retention:read",
        "retention:write",
      ],
    });
    expect(decoded.signature).toBe(
      createHmac("sha256", CONFIG.serviceJwtSecret)
        .update(decoded.signingInput)
        .digest("base64url"),
    );
  });

  test("uses a short, exact expiry window", () => {
    const minted = mintRetentionServiceToken(CONFIG, PRINCIPAL, 10_999);
    const claims = decodeToken(minted.token).claims;

    expect(minted.issuedAtSeconds).toBe(10);
    expect(minted.expiresAtSeconds).toBe(40);
    expect(claims.iat).toBe(10);
    expect(claims.nbf).toBe(10);
    expect(claims.exp).toBe(40);
  });

  test("rejects missing and unknown roles", () => {
    expect(() =>
      mintRetentionServiceToken(CONFIG, { ...PRINCIPAL, roles: [] }, 10_000),
    ).toThrow("At least one");
    expect(() =>
      mintRetentionServiceToken(
        CONFIG,
        {
          ...PRINCIPAL,
          roles: ["retention_root" as "retention_viewer"],
        },
        10_000,
      ),
    ).toThrow("role is invalid");
  });
});
