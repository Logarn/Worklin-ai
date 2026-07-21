/**
 * Token exchange module for the gateway's auth system.
 *
 * The gateway receives edge tokens (aud=vellum-gateway) from external clients
 * and mints short-lived exchange tokens (aud=vellum-daemon) for forwarding
 * to the runtime. This exchange proves gateway origin — only the gateway
 * holds the signing key needed to mint daemon-audience tokens.
 *
 * Exchange tokens have a 60-second TTL and rewrite the sub claim's assistant
 * segment to 'self' (the daemon's internal scope constant).
 */

import { randomUUID } from "node:crypto";

import { getLogger } from "../logger.js";

import { CURRENT_POLICY_EPOCH } from "./policy.js";
import { parseSub } from "./subject.js";
import { mintToken, verifyToken, type VerifyResult } from "./token-service.js";
import type {
  RuntimeTenantContextClaim,
  ScopeProfile,
  TokenClaims,
} from "./types.js";

const log = getLogger("token-exchange");

/** TTL for exchange tokens — short-lived, minted per-request. */
const EXCHANGE_TOKEN_TTL_SECONDS = 60;

function serviceTenantContext():
  | NonNullable<TokenClaims["service_tenant_context"]>
  | undefined {
  const assistantId = process.env.WORKLIN_PLATFORM_ASSISTANT_ID?.trim();
  if (!assistantId) return undefined;
  const organizationId = process.env.PLATFORM_ORGANIZATION_ID?.trim();
  return {
    version: 1,
    assistant_id: assistantId,
    service_id: "gateway",
    request_id: randomUUID(),
    ...(organizationId ? { organization_id: organizationId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Edge token validation
// ---------------------------------------------------------------------------

/**
 * Validate a JWT edge token intended for the gateway (aud=vellum-gateway).
 *
 * Returns the verified claims on success, or a structured error on failure.
 * Pass `allowExpired: true` to accept expired-but-otherwise-valid tokens
 * (signature, audience, and policy epoch are still checked). This is used
 * by the refresh endpoint so clients can obtain new credentials even after
 * the access token has expired.
 */
export function validateEdgeToken(
  token: string,
  opts?: { allowExpired?: boolean },
): VerifyResult {
  return verifyToken(token, "vellum-gateway", opts);
}

// ---------------------------------------------------------------------------
// Exchange token minting
// ---------------------------------------------------------------------------

/**
 * Mint a short-lived exchange token (aud=vellum-daemon) from validated
 * edge claims. The sub claim's assistant segment is rewritten to 'self'
 * so the daemon always uses its internal scope constant.
 */
export function mintExchangeToken(
  edgeClaims: TokenClaims,
  targetScopeProfile: ScopeProfile,
): string {
  const parsed = parseSub(edgeClaims.sub);
  let exchangeSub: string;

  if (!parsed.ok) {
    // If sub parsing fails, log and use a gateway service sub as fallback
    log.warn(
      { sub: edgeClaims.sub, reason: parsed.reason },
      "Failed to parse edge token sub, using gateway service sub",
    );
    exchangeSub = "svc:gateway:self";
  } else {
    // Rewrite the assistant segment to 'self'
    switch (parsed.principalType) {
      case "actor":
        exchangeSub = `actor:self:${parsed.actorPrincipalId}`;
        break;
      case "svc_gateway":
        exchangeSub = "svc:gateway:self";
        break;
      case "local":
        exchangeSub = `local:self:${parsed.conversationId}`;
        break;
      default:
        exchangeSub = "svc:gateway:self";
    }
  }

  const nowSeconds = Math.floor(Date.now() / 1_000);
  const ttlSeconds = edgeClaims.pooled_worker_lease
    ? Math.min(
        EXCHANGE_TOKEN_TTL_SECONDS,
        edgeClaims.exp - nowSeconds,
        edgeClaims.pooled_worker_lease.lease_expires_at - nowSeconds,
      )
    : EXCHANGE_TOKEN_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error("Pooled worker lease token has expired.");
  }

  return mintToken({
    aud: "vellum-daemon",
    sub: exchangeSub,
    scope_profile: targetScopeProfile,
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds,
    ...(edgeClaims.artifact_id ? { artifact_id: edgeClaims.artifact_id } : {}),
    ...(edgeClaims.collaboration_role
      ? { collaboration_role: edgeClaims.collaboration_role }
      : {}),
    ...(edgeClaims.tenant_context
      ? { tenant_context: edgeClaims.tenant_context }
      : {}),
    ...(edgeClaims.service_tenant_context
      ? { service_tenant_context: edgeClaims.service_tenant_context }
      : {}),
    ...(edgeClaims.pooled_worker_lease
      ? { pooled_worker_lease: edgeClaims.pooled_worker_lease }
      : {}),
    ...(edgeClaims.pooled_worker_lease && edgeClaims.jti
      ? { jti: edgeClaims.jti }
      : {}),
  });
}

/**
 * Mint a daemon actor capability from caller identity attested by the managed
 * Velay bridge. This gives WebSocket upgrades the same signed tenant envelope
 * as ordinary control-plane actor requests.
 */
export function mintRuntimeTenantActorToken(
  tenantContext: RuntimeTenantContextClaim,
): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: `actor:self:${tenantContext.actor_id}`,
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: EXCHANGE_TOKEN_TTL_SECONDS,
    tenant_context: tenantContext,
  });
}

// ---------------------------------------------------------------------------
// Gateway-minted service tokens
// ---------------------------------------------------------------------------

/**
 * Mint an ingress exchange token for webhook handlers.
 * Used after platform signature validation (Telegram, Twilio, WhatsApp, Slack)
 * to forward authenticated inbound events to the runtime.
 *
 * sub=svc:gateway:self, scope_profile=gateway_ingress_v1
 */
export function mintIngressToken(): string {
  const tenantContext = serviceTenantContext();
  return mintToken({
    aud: "vellum-daemon",
    sub: "svc:gateway:self",
    scope_profile: "gateway_ingress_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: EXCHANGE_TOKEN_TTL_SECONDS,
    ...(tenantContext ? { service_tenant_context: tenantContext } : {}),
  });
}

/**
 * Mint a service token for gateway-to-runtime service calls.
 * Used for delivery endpoints, control-plane proxies, and other
 * gateway-originated requests to the daemon.
 *
 * sub=svc:gateway:self, scope_profile=gateway_service_v1
 */
export function mintServiceToken(): string {
  const tenantContext = serviceTenantContext();
  return mintToken({
    aud: "vellum-daemon",
    sub: "svc:gateway:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: EXCHANGE_TOKEN_TTL_SECONDS,
    ...(tenantContext ? { service_tenant_context: tenantContext } : {}),
  });
}

/**
 * Mint a relay token for Twilio WebSocket connections.
 *
 * The gateway's relay/media-stream WS handlers validate these tokens via
 * {@link validateEdgeToken} (aud=vellum-gateway). Previously minted by the
 * daemon and embedded in TwiML; now minted by the gateway and injected into
 * the TwiML response before it reaches Twilio.
 *
 * sub=svc:gateway:self, scope_profile=gateway_service_v1
 */
export function mintRelayToken(): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: "svc:gateway:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: EXCHANGE_TOKEN_TTL_SECONDS,
  });
}

/**
 * Mint a JWT for embedding in browser-served UI pages (brain-graph).
 *
 * The daemon returns HTML containing a placeholder; the gateway replaces it
 * with this token before serving the page. Uses the ui_page_v1 scope profile
 * which grants only settings.read — the minimum needed for the brain-graph
 * data endpoint. 1-hour TTL gives users time to interact with the page.
 */
export function mintUiPageToken(): string {
  return mintToken({
    aud: "vellum-gateway",
    sub: "svc:gateway:self",
    scope_profile: "ui_page_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 3600,
  });
}
