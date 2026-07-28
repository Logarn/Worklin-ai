import { createHmac, randomUUID } from "node:crypto";

import type { EnabledRetentionServiceConfig } from "./retention-service-config.js";

const JWT_HEADER = Buffer.from(
  JSON.stringify({ alg: "HS256", typ: "JWT" }),
).toString("base64url");
const TOKEN_ISSUER = "worklin-control-plane";
const TOKEN_AUDIENCE = "worklin-retention-service";

const ROLE_PERMISSIONS = {
  retention_viewer: ["retention:read"],
  retention_marketer: [
    "retention:read",
    "retention:write",
    "retention:generate",
  ],
  retention_campaign_approver: ["retention:read", "retention:approve"],
  retention_campaign_sender: ["retention:read", "retention:send"],
  retention_owner: [
    "retention:read",
    "retention:write",
    "retention:generate",
    "retention:approve",
    "retention:send",
    "retention:integrations",
  ],
} as const;

export type RetentionServiceRole = keyof typeof ROLE_PERMISSIONS;
export type RetentionServicePermission =
  (typeof ROLE_PERMISSIONS)[RetentionServiceRole][number];

export interface RetentionServicePrincipal {
  organizationId: string;
  userId: string;
  assistantId: string;
  roles: readonly RetentionServiceRole[];
}

export type RetentionProvider = "shopify" | "klaviyo";

export interface RetentionProviderWebhookBinding {
  organizationId: string;
  userId: string;
  assistantId: string;
  integrationConnectionId: string;
  provider: RetentionProvider;
}

export interface MintedRetentionServiceToken {
  token: string;
  issuedAtSeconds: number;
  expiresAtSeconds: number;
}

export function mintRetentionServiceToken(
  config: EnabledRetentionServiceConfig,
  principal: RetentionServicePrincipal,
  nowMs = Date.now(),
): MintedRetentionServiceToken {
  const organizationId = assertClaim(principal.organizationId, "organization");
  const userId = assertClaim(principal.userId, "user");
  const assistantId = assertClaim(principal.assistantId, "assistant");
  const roles = normalizeRoles(principal.roles);
  const permissions = permissionsForRoles(roles);
  const issuedAtSeconds = assertNow(nowMs);
  const expiresAtSeconds = issuedAtSeconds + config.tokenTtlSeconds;

  return {
    token: signJwt(
      {
        iss: TOKEN_ISSUER,
        aud: TOKEN_AUDIENCE,
        sub: `user:${userId}`,
        iat: issuedAtSeconds,
        nbf: issuedAtSeconds,
        exp: expiresAtSeconds,
        jti: randomUUID(),
        token_use: "retention_service",
        organization_id: organizationId,
        user_id: userId,
        assistant_id: assistantId,
        roles,
        permissions,
      },
      config.serviceJwtSecret,
    ),
    issuedAtSeconds,
    expiresAtSeconds,
  };
}

export function mintRetentionProviderWebhookToken(
  config: EnabledRetentionServiceConfig,
  binding: RetentionProviderWebhookBinding,
  nowMs = Date.now(),
): MintedRetentionServiceToken {
  const organizationId = assertClaim(binding.organizationId, "organization");
  const userId = assertClaim(binding.userId, "user");
  const assistantId = assertClaim(binding.assistantId, "assistant");
  const connectionId = assertClaim(
    binding.integrationConnectionId,
    "integration connection",
  );
  const provider = assertProvider(binding.provider);
  const issuedAtSeconds = assertNow(nowMs);
  const expiresAtSeconds = issuedAtSeconds + config.tokenTtlSeconds;

  return {
    token: signJwt(
      {
        iss: TOKEN_ISSUER,
        aud: TOKEN_AUDIENCE,
        sub: `provider-webhook:${provider}:${connectionId}`,
        iat: issuedAtSeconds,
        nbf: issuedAtSeconds,
        exp: expiresAtSeconds,
        jti: randomUUID(),
        token_use: "provider_webhook",
        organization_id: organizationId,
        user_id: userId,
        assistant_id: assistantId,
        integration_connection_id: connectionId,
        provider,
        roles: ["retention_provider_webhook"],
        permissions: ["retention:webhook:ingest"],
      },
      config.serviceJwtSecret,
    ),
    issuedAtSeconds,
    expiresAtSeconds,
  };
}

export function assertRetentionProvider(
  provider: string,
): RetentionProvider {
  return assertProvider(provider);
}

function permissionsForRoles(
  roles: readonly RetentionServiceRole[],
): RetentionServicePermission[] {
  const permissions = new Set<RetentionServicePermission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) {
      permissions.add(permission);
    }
  }
  return [...permissions].sort();
}

function normalizeRoles(
  roles: readonly RetentionServiceRole[] | undefined,
): RetentionServiceRole[] {
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new Error("At least one retention service role is required.");
  }
  const unique = new Set<RetentionServiceRole>();
  for (const role of roles) {
    if (!isRetentionServiceRole(role)) {
      throw new Error("Retention service role is invalid.");
    }
    unique.add(role);
  }
  return [...unique].sort();
}

function isRetentionServiceRole(role: unknown): role is RetentionServiceRole {
  return (
    typeof role === "string" &&
    Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role)
  );
}

function assertProvider(provider: string): RetentionProvider {
  if (provider !== "shopify" && provider !== "klaviyo") {
    throw new Error("Retention provider is invalid.");
  }
  return provider;
}

function assertClaim(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`Retention service ${label} claim is invalid.`);
  }
  return value;
}

function assertNow(nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Retention service token time is invalid.");
  }
  return Math.floor(nowMs / 1_000);
}

function signJwt(claims: Record<string, unknown>, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${JWT_HEADER}.${payload}`;
  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}
