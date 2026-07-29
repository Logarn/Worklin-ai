import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";

import { z } from "zod";

const claimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.string().min(1),
  sub: z.string().min(1),
  organization_id: z.string().uuid(),
  user_id: z.string().min(1),
  assistant_id: z.string().min(1),
  token_use: z.enum(["retention_service", "provider_webhook"]),
  integration_connection_id: z.string().min(1).optional(),
  provider: z.enum(["shopify", "klaviyo"]).optional(),
  roles: z.array(z.string()).default([]),
  permissions: z.array(z.string()).default([]),
  iat: z.number().int().nonnegative(),
  nbf: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  jti: z.string().min(1),
}).superRefine((claims, context) => {
  if (
    claims.token_use === "provider_webhook" &&
    (!claims.integration_connection_id || !claims.provider)
  ) {
    context.addIssue({
      code: "custom",
      message: "Provider webhook tokens require an integration and provider.",
    });
  }
});

export type RetentionActorClaims = z.infer<typeof claimsSchema>;

export class RetentionAuthenticationError extends Error {
  readonly code = "retention_authentication_failed";
}

function decodeJsonPart(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new RetentionAuthenticationError("Malformed retention token.");
  }
}

export function verifyRetentionActorToken(input: {
  token: string;
  signingKey: Buffer;
  issuer: string;
  audience: string;
  nowMs?: number;
}): RetentionActorClaims {
  const parts = input.token.split(".");
  if (parts.length !== 3) {
    throw new RetentionAuthenticationError("Malformed retention token.");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = z
    .object({ alg: z.literal("HS256"), typ: z.literal("JWT") })
    .safeParse(decodeJsonPart(encodedHeader!));
  if (!header.success) {
    throw new RetentionAuthenticationError(
      "Unsupported retention token header.",
    );
  }

  const expectedSignature = createHmac("sha256", input.signingKey)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  let providedSignature: Buffer;
  try {
    providedSignature = Buffer.from(encodedSignature!, "base64url");
  } catch {
    throw new RetentionAuthenticationError(
      "Invalid retention token signature.",
    );
  }
  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    throw new RetentionAuthenticationError(
      "Invalid retention token signature.",
    );
  }

  const parsed = claimsSchema.safeParse(decodeJsonPart(encodedPayload!));
  if (!parsed.success) {
    throw new RetentionAuthenticationError("Invalid retention token claims.");
  }
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (
    parsed.data.iss !== input.issuer ||
    parsed.data.aud !== input.audience ||
    parsed.data.iat > nowSeconds + 30 ||
    parsed.data.nbf > nowSeconds + 30 ||
    parsed.data.exp <= nowSeconds
  ) {
    throw new RetentionAuthenticationError(
      "Expired or mis-scoped retention token.",
    );
  }
  return parsed.data;
}

export function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match) {
    throw new RetentionAuthenticationError(
      "Retention authentication is required.",
    );
  }
  return match[1]!;
}

export function requireRetentionPermission(
  claims: RetentionActorClaims,
  permission: string,
): void {
  if (
    !claims.permissions.includes(permission) &&
    !claims.permissions.includes("retention:*")
  ) {
    throw new RetentionAuthenticationError(
      "Retention permission is required.",
    );
  }
}
