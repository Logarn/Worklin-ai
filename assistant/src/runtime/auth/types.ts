/**
 * Core auth types for the single-header JWT auth system.
 *
 * These types define the token claims, scope profiles, principal types,
 * and the normalized AuthContext that downstream code consumes.
 */

// ---------------------------------------------------------------------------
// Scope profiles — named bundles of permissions
// ---------------------------------------------------------------------------

export type ScopeProfile =
  | "actor_client_v1"
  | "gateway_ingress_v1"
  | "gateway_service_v1"
  | "local_v1"
  | "ui_page_v1"
  | "artifact_viewer_v1"
  | "artifact_commenter_v1"
  | "artifact_editor_v1";

// ---------------------------------------------------------------------------
// Individual scope strings
// ---------------------------------------------------------------------------

export type Scope =
  | "chat.read"
  | "chat.write"
  | "approval.read"
  | "approval.write"
  | "settings.read"
  | "settings.write"
  | "attachments.read"
  | "attachments.write"
  | "calls.read"
  | "calls.write"
  | "ingress.write"
  | "internal.write"
  | "feature_flags.read"
  | "feature_flags.write"
  | "local.all"
  | "artifact.read"
  | "artifact.comment"
  | "artifact.write";

// ---------------------------------------------------------------------------
// Principal types — derived from the sub pattern
// ---------------------------------------------------------------------------

export type PrincipalType = "actor" | "svc_gateway" | "svc_daemon" | "local";

// ---------------------------------------------------------------------------
// Token audience — which service the JWT is intended for
// ---------------------------------------------------------------------------

export type TokenAudience = "vellum-gateway" | "vellum-daemon";

// ---------------------------------------------------------------------------
// JWT claims — the payload inside the token
// ---------------------------------------------------------------------------

export interface RuntimeTenantContextClaim {
  version: 1;
  organization_id: string;
  user_id: string;
  assistant_id: string;
  actor_id: string;
  request_id: string;
}

export interface RuntimeServiceTenantContextClaim {
  version: 1;
  assistant_id: string;
  service_id: "gateway";
  request_id: string;
  organization_id?: string;
}

export interface RuntimeWorkerLeaseClaim {
  version: 1;
  issuer_service_id: "runtime_dispatcher";
  organization_id: string;
  user_id: string;
  assistant_id: string;
  worker_stack_id: string;
  lease_generation: number;
  lease_expires_at: number;
}

export interface TokenClaims {
  iss: "vellum-auth";
  aud: TokenAudience;
  sub: string;
  scope_profile: ScopeProfile;
  exp: number;
  policy_epoch: number;
  iat?: number;
  jti?: string;
  artifact_id?: string;
  collaboration_role?: "viewer" | "commenter" | "editor" | "owner";
  tenant_context?: RuntimeTenantContextClaim;
  service_tenant_context?: RuntimeServiceTenantContextClaim;
  pooled_worker_lease?: RuntimeWorkerLeaseClaim;
}

// ---------------------------------------------------------------------------
// AuthContext — normalized auth state for downstream consumers
// ---------------------------------------------------------------------------

export interface RuntimeTenantContext {
  version: 1;
  organizationId: string;
  userId: string;
  assistantId: string;
  actorId: string;
  requestId: string;
}

export interface RuntimeServiceTenantContext {
  version: 1;
  assistantId: string;
  serviceId: "gateway";
  requestId: string;
  organizationId?: string;
}

export interface RuntimeWorkerLeaseContext {
  version: 1;
  organizationId: string;
  userId: string;
  assistantId: string;
  workerStackId: string;
  leaseGeneration: number;
  leaseExpiresAtSeconds: number;
}

export interface AuthContext {
  subject: string;
  principalType: PrincipalType;
  assistantId: string;
  actorPrincipalId?: string;
  conversationId?: string;
  scopeProfile: ScopeProfile;
  scopes: ReadonlySet<Scope>;
  policyEpoch: number;
  artifactId?: string;
  collaborationRole?: "viewer" | "commenter" | "editor" | "owner";
  tenantContext?: RuntimeTenantContext;
  serviceTenantContext?: RuntimeServiceTenantContext;
  pooledWorkerLease?: RuntimeWorkerLeaseContext;
}
