export type RetentionProvider = "shopify" | "klaviyo";

export type KlaviyoPropertyAccessMode = "allowlist" | "all";

export type RetentionProgram =
  "non_buyer_conversion" | "re_engagement" | "repeat_purchase";

export type RetentionCampaignMode = "dynamic_template" | "individual_message";

export type RetentionCampaignStatus =
  | "draft"
  | "audience_frozen"
  | "generating"
  | "review_required"
  | "approved"
  | "ready_to_send"
  | "sending"
  | "sent"
  | "partially_sent"
  | "failed"
  | "cancelled";

export interface TenantContext {
  organizationId: string;
  userId: string;
  assistantId: string;
  roles: string[];
  permissions: string[];
  requestId: string;
}

export interface SourceEventInput {
  integrationId: string;
  provider: RetentionProvider;
  externalEventId: string;
  eventType: string;
  occurredAt: string;
  customerExternalId?: string;
  payload: unknown;
  signatureVerified: boolean;
  ingestionChannel?: "webhook" | "provider_sync";
}

export interface NormalizedCustomerSignal {
  externalId?: string;
  email?: string;
  phone?: string;
  displayName?: string;
}

export interface NormalizedConsentSignal {
  channel: "email" | "sms" | "push" | "whatsapp";
  state: "subscribed" | "unsubscribed" | "suppressed" | "unknown";
}

export interface NormalizedTraitSignal {
  key: string;
  value: unknown;
  evidenceKind: "observed" | "declared" | "imported";
  sensitivity: "standard" | "personal" | "sensitive" | "restricted";
  confidence: number;
  expiresAt?: string;
}

export interface NormalizedSourcePayload {
  customer?: NormalizedCustomerSignal;
  consent?: NormalizedConsentSignal;
  traits?: NormalizedTraitSignal[];
  commerce?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  source: Record<string, unknown>;
}

export interface SourceEventResult {
  id: string;
  duplicate: boolean;
  jobId: string | null;
}

export interface RetentionServiceReadiness {
  ok: boolean;
  database: "ready" | "unavailable";
  migrations: "ready" | "pending" | "failed";
  externalWritesEnabled: boolean;
  sendEnabled: boolean;
}

export class RetentionServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
