import { createHash, randomUUID } from "node:crypto";

import {
  createAiRecipientDecision,
  getCampaignApprovalChecksum,
  getProgramPolicyApprovalChecksum,
  type CampaignApprovalMaterial,
  type ProgramPolicyApprovalMaterial,
  type RetentionJsonValue,
  type WorklinSegmentExpression,
  validateWorklinSegmentExpression,
} from "@vellumai/retention-domain";

import type { RetentionActorClaims } from "./auth.js";
import { RetentionCrypto } from "./crypto.js";
import { RetentionDatabase, type RetentionTransactionSql } from "./database.js";
import {
  RetentionServiceError,
  type KlaviyoPropertyAccessMode,
  type NormalizedSourcePayload,
  type RetentionCampaignMode,
  type RetentionProgram,
  type SourceEventInput,
  type SourceEventResult,
  type TenantContext,
} from "./types.js";
import {
  normalizeEmail,
  normalizePhone,
  parseNormalizedSourcePayload,
} from "./normalization.js";
import {
  assertCampaignCanCancel,
  operatorCustomerReference,
  operatorDecisionRationale,
  redactOperatorText,
} from "./operator-views.js";
import { validateMessageQuality } from "./message-quality.js";
import { buildMessageQualityEvidence } from "./message-quality-policy.js";
import {
  isApprovedKlaviyoTraitKey,
  KlaviyoProviderSyncClient,
  ProviderSyncError,
  ShopifyProviderSyncClient,
  type ProviderSyncCheckpoint,
  type ProviderSyncLifecycle,
} from "./provider-sync.js";
import {
  campaignEligibility,
  evaluateSegmentExpression,
  scalarForDossier,
  validateSafeSegmentExpression,
  type SegmentCustomerState,
} from "./segment-runs.js";
import { SegmentDiscoveryProfiler } from "./segment-discovery.js";
import {
  rawPayloadReference,
  type RawPayloadStore,
} from "./raw-payload-store.js";

const PROVIDER_PAGE_INGEST_CONCURRENCY = 6;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableUuid(value: string): string {
  const digest = sha256(value).slice(0, 32).split("");
  digest[12] = "5";
  digest[16] = "8";
  const hex = digest.join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function encryptedJson(
  crypto: RetentionCrypto,
  value: unknown,
  context: string,
): string {
  return crypto.encrypt(canonicalJson(value), context);
}

function assertUuid(value: string, label: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new RetentionServiceError(
      "invalid_identifier",
      `${label} must be a UUID.`,
      400,
    );
  }
}

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/iu.test(value)) {
    throw new RetentionServiceError(
      "invalid_checksum",
      `${label} must be a SHA-256 checksum.`,
      400,
    );
  }
}

function assertConfidence(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RetentionServiceError(
      "invalid_confidence",
      "Decision confidence must be between 0 and 1.",
      400,
    );
  }
}

function assertNonNegativeMoney(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new RetentionServiceError(
      "invalid_cost_estimate",
      `${label} must be a non-negative amount.`,
      400,
    );
  }
}

const MAX_PRIVACY_EXPORT_BYTES = 1024 * 1024;

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function normalizedSourceEventType(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/_/gu, "/");
}

function isShopifyIntegrationUninstall(
  provider: "shopify" | "klaviyo",
  eventType: string,
): boolean {
  return (
    provider === "shopify" &&
    normalizedSourceEventType(eventType) === "app/uninstalled"
  );
}

function isShopifyShopRedaction(
  provider: "shopify" | "klaviyo",
  eventType: string,
): boolean {
  return (
    provider === "shopify" &&
    normalizedSourceEventType(eventType) === "shop/redact"
  );
}

function isCustomerPrivacyDeletion(
  provider: "shopify" | "klaviyo",
  eventType: string,
): boolean {
  if (provider !== "shopify") return false;
  return [
    "customers/delete",
    "customers/redact",
    "customer/delete",
    "customer/redact",
  ].includes(normalizedSourceEventType(eventType));
}

export function tenantContextFromClaims(
  claims: RetentionActorClaims,
): TenantContext {
  return {
    organizationId: claims.organization_id,
    userId: claims.user_id,
    assistantId: claims.assistant_id,
    roles: claims.roles,
    permissions: claims.permissions,
    requestId: claims.jti,
  };
}

interface RepositoryOptions {
  maxJobAttempts: number;
  jobLeaseSeconds: number;
  externalWritesEnabled: boolean;
  sendEnabled: boolean;
  rawPayloadStore: RawPayloadStore;
  providerFetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

type ProviderSyncResource = "customers" | "orders" | "profiles" | "events";

export interface ProviderSyncJobPayload {
  integrationId: string;
  migrationRunId?: string;
  lifecycle: ProviderSyncLifecycle;
  resource: ProviderSyncResource;
}

interface ProviderResourceSyncState extends ProviderSyncCheckpoint {
  completed: boolean;
}

interface ProviderIntegrationCursor {
  version: 1;
  historical_backfill?: Partial<
    Record<ProviderSyncResource, ProviderResourceSyncState>
  >;
  incremental_poll?: Partial<
    Record<ProviderSyncResource, ProviderResourceSyncState>
  >;
  reconciliation?: Partial<
    Record<ProviderSyncResource, ProviderResourceSyncState>
  >;
}

const PROVIDER_SYNC_RESOURCES = {
  shopify: ["customers", "orders"],
  klaviyo: ["profiles", "events"],
} as const satisfies Record<
  "shopify" | "klaviyo",
  readonly ProviderSyncResource[]
>;

function emptyProviderSyncState(): ProviderResourceSyncState {
  return {
    cursor: null,
    watermark: null,
    pendingWatermark: null,
    completed: false,
  };
}

function parseProviderCursor(value: unknown): ProviderIntegrationCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: 1 };
  }
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1
    ? (candidate as unknown as ProviderIntegrationCursor)
    : { version: 1 };
}

function segmentTraitAllowlistFromDossier(value: unknown): ReadonlySet<string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return new Set();
  }
  const grammar = (value as Record<string, unknown>).expressionGrammar;
  if (!grammar || typeof grammar !== "object" || Array.isArray(grammar)) {
    return new Set();
  }
  const namespaces = (grammar as Record<string, unknown>).namespaces;
  if (
    !namespaces ||
    typeof namespaces !== "object" ||
    Array.isArray(namespaces)
  ) {
    return new Set();
  }
  const traits = (namespaces as Record<string, unknown>).trait;
  return new Set(
    (Array.isArray(traits) ? traits : []).filter(
      (trait): trait is string =>
        typeof trait === "string" &&
        trait.trim().length > 0 &&
        trait.length <= 160 &&
        !/[\u0000-\u001f\u007f]/u.test(trait),
    ),
  );
}

interface ProcessedSourceEvent {
  id: string;
  brand_id: string;
  integration_id: string;
  provider: "shopify" | "klaviyo";
  external_event_id: string;
  event_type: string;
  occurred_at: Date;
}

export interface SegmentRunCompletionInput {
  runId: string;
  leaseOwner: string;
  outcome: "continue" | "pause" | "complete";
  errorCode?: string;
  definitions: Array<{
    name: string;
    description: string;
    expression: WorklinSegmentExpression;
    confidence: number;
    evidence: string[];
    campaignPreview: {
      strategy: unknown;
      qualityStatus: "passed" | "needs_review" | "blocked";
      qualityIssues: string[];
      modelProvider: string;
      modelId: string;
      promptVersion: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens?: number;
      };
      samples: Array<{
        customerReference: string;
        subject: string;
        preheader?: string;
        body: string;
        explanation: string;
      }>;
    };
  }>;
}

interface StoredSegmentDefinition {
  id: string;
  name: string;
  version: number;
  checksum: string;
  expression: WorklinSegmentExpression;
}

export class RetentionRepository {
  constructor(
    readonly database: RetentionDatabase,
    readonly crypto: RetentionCrypto,
    readonly options: RepositoryOptions,
  ) {}

  async initializeTenant(context: TenantContext): Promise<void> {
    await this.database.withTenant(context.organizationId, async (tx) => {
      const rows = await tx<Array<{ exists: boolean }>>`
          SELECT EXISTS (
            SELECT 1
            FROM retention_tenant_registry
            WHERE org_id = ${context.organizationId}
          ) AS exists
        `;
      const existed = rows[0]?.exists === true;
      await tx`
        INSERT INTO retention_tenant_registry (org_id)
        VALUES (${context.organizationId})
        ON CONFLICT (org_id) DO NOTHING
      `;
      await tx`
        INSERT INTO retention_org_settings (org_id)
        VALUES (${context.organizationId})
        ON CONFLICT (org_id) DO NOTHING
      `;
      if (!existed) {
        await this.audit(tx, context, {
          action: "tenant.initialized",
          resourceType: "organization",
          resourceId: context.organizationId,
        });
      }
    });
  }

  async status(
    context: TenantContext,
    input: { brandId: string },
  ): Promise<{
    organizationId: string;
    integrations: Array<{
      brandId: string;
      brandName: string;
      provider: string;
      status: string;
      lastWebhookAt: string | null;
      lastPolledAt: string | null;
      lastReconciledAt: string | null;
      lastErrorCode: string | null;
    }>;
    jobs: Record<string, number>;
    externalWritesEnabled: boolean;
    sendEnabled: boolean;
  }> {
    return this.database.withTenant(context.organizationId, async (tx) => {
      const queryRows = await tx<
        Array<{
          brand_id: string;
          brand_name: string;
          provider: string;
          status: string;
          last_webhook_at: Date | null;
          last_polled_at: Date | null;
          last_reconciled_at: Date | null;
          last_error_code: string | null;
        }>
      >`
        SELECT
          integration.brand_id,
          brand.name AS brand_name,
          integration.provider,
          integration.status,
          integration.last_webhook_at,
          integration.last_polled_at,
          integration.last_reconciled_at,
          integration.last_error_code
        FROM retention_integrations AS integration
        INNER JOIN retention_brands AS brand
          ON brand.org_id = integration.org_id
          AND brand.id = integration.brand_id
        WHERE integration.org_id = ${context.organizationId}
          AND integration.brand_id = ${input.brandId}
        ORDER BY integration.provider, brand.name
      `;
      const integrations = queryRows;
      const jobRows = await tx<Array<{ status: string; count: string }>>`
        SELECT status, count(*)::TEXT AS count
        FROM retention_jobs
        WHERE org_id = ${context.organizationId}
        GROUP BY status
      `;
      const settings = await tx<
        Array<{
          external_writes_enabled: boolean;
          send_enabled: boolean;
        }>
      >`
        SELECT external_writes_enabled, send_enabled
        FROM retention_org_settings
        WHERE org_id = ${context.organizationId}
      `;
      return {
        organizationId: context.organizationId,
        integrations: integrations.map((row) => ({
          brandId: row.brand_id,
          brandName: row.brand_name,
          provider: row.provider,
          status: row.status,
          lastWebhookAt: row.last_webhook_at?.toISOString() ?? null,
          lastPolledAt: row.last_polled_at?.toISOString() ?? null,
          lastReconciledAt: row.last_reconciled_at?.toISOString() ?? null,
          lastErrorCode: row.last_error_code,
        })),
        jobs: Object.fromEntries(
          jobRows.map((row) => [row.status, Number(row.count)]),
        ),
        externalWritesEnabled:
          this.options.externalWritesEnabled &&
          settings[0]?.external_writes_enabled === true,
        sendEnabled:
          this.options.sendEnabled && settings[0]?.send_enabled === true,
      };
    });
  }

  async customerPrivacyAccess(
    context: TenantContext,
    customerId: string,
  ): Promise<{
    customerId: string;
    brandId: string;
    status: string;
    profile: {
      email: string | null;
      phone: string | null;
      displayName: string | null;
    };
    recordCounts: {
      identities: number;
      traits: number;
      consentEvents: number;
      sourceEvents: number;
      decisions: number;
      messages: number;
      segmentMemberships: number;
    };
    updatedAt: string;
  }> {
    assertUuid(customerId, "customerId");
    const result = await this.database.withTenant(
      context.organizationId,
      async (tx) => {
        const rows = await tx<
          Array<{
            brand_id: string;
            status: string;
            primary_email_ciphertext: string | null;
            primary_phone_ciphertext: string | null;
            display_name_ciphertext: string | null;
            updated_at: Date;
            identity_count: string;
            trait_count: string;
            consent_count: string;
            source_event_count: string;
            decision_count: string;
            message_count: string;
            segment_membership_count: string;
          }>
        >`
          SELECT
            customer.brand_id,
            customer.status,
            customer.primary_email_ciphertext,
            customer.primary_phone_ciphertext,
            customer.display_name_ciphertext,
            customer.updated_at,
            (
              SELECT count(*)::TEXT
              FROM retention_customer_identities
              WHERE org_id = customer.org_id
                AND customer_id = customer.id
            ) AS identity_count,
            (
              SELECT count(*)::TEXT
              FROM retention_customer_traits
              WHERE org_id = customer.org_id
                AND customer_id = customer.id
            ) AS trait_count,
            (
              SELECT count(*)::TEXT
              FROM retention_consent_events
              WHERE org_id = customer.org_id
                AND customer_id = customer.id
            ) AS consent_count,
            (
              SELECT count(*)::TEXT
              FROM retention_source_events
              WHERE org_id = customer.org_id
                AND customer_id = customer.id
            ) AS source_event_count,
            (
              SELECT count(*)::TEXT
              FROM retention_customer_decisions
              WHERE org_id = customer.org_id
                AND customer_id = customer.id
            ) AS decision_count,
            (
              SELECT count(*)::TEXT
              FROM retention_rendered_messages
              WHERE org_id = customer.org_id
                AND customer_id = customer.id
            ) AS message_count,
            (
              SELECT count(*)::TEXT
              FROM retention_segment_memberships
              WHERE org_id = customer.org_id
                AND customer_id = customer.id
            ) AS segment_membership_count
          FROM retention_customers AS customer
          WHERE customer.org_id = ${context.organizationId}
            AND customer.id = ${customerId}
            AND customer.status <> 'deleted'
        `;
        const row = rows[0];
        await this.audit(tx, context, {
          action: "customer.privacy_access_requested",
          resourceType: "customer",
          resourceId: customerId,
          metadata: { found: Boolean(row) },
        });
        if (!row) return null;
        return {
          customerId,
          brandId: row.brand_id,
          status: row.status,
          profile: {
            email: row.primary_email_ciphertext
              ? this.crypto.decrypt(
                  row.primary_email_ciphertext,
                  `${context.organizationId}:customer:${customerId}:email`,
                )
              : null,
            phone: row.primary_phone_ciphertext
              ? this.crypto.decrypt(
                  row.primary_phone_ciphertext,
                  `${context.organizationId}:customer:${customerId}:phone`,
                )
              : null,
            displayName: this.decryptCustomerDisplayName(
              context.organizationId,
              customerId,
              row.display_name_ciphertext,
            ),
          },
          recordCounts: {
            identities: Number(row.identity_count),
            traits: Number(row.trait_count),
            consentEvents: Number(row.consent_count),
            sourceEvents: Number(row.source_event_count),
            decisions: Number(row.decision_count),
            messages: Number(row.message_count),
            segmentMemberships: Number(row.segment_membership_count),
          },
          updatedAt: row.updated_at.toISOString(),
        };
      },
    );
    if (!result) {
      throw new RetentionServiceError(
        "customer_not_found",
        "The retention customer was not found.",
        404,
      );
    }
    return result;
  }

  async exportCustomerData(
    context: TenantContext,
    customerId: string,
  ): Promise<Record<string, unknown>> {
    assertUuid(customerId, "customerId");
    const result = await this.database.withTenant(
      context.organizationId,
      async (tx) => {
        const customers = await tx<
          Array<{
            brand_id: string;
            status: string;
            primary_email_ciphertext: string | null;
            primary_phone_ciphertext: string | null;
            display_name_ciphertext: string | null;
            source_updated_at: Date | null;
            created_at: Date;
            updated_at: Date;
          }>
        >`
          SELECT
            brand_id,
            status,
            primary_email_ciphertext,
            primary_phone_ciphertext,
            display_name_ciphertext,
            source_updated_at,
            created_at,
            updated_at
          FROM retention_customers
          WHERE org_id = ${context.organizationId}
            AND id = ${customerId}
            AND status <> 'deleted'
        `;
        const customer = customers[0];
        if (!customer) {
          await this.audit(tx, context, {
            action: "customer.privacy_export_requested",
            resourceType: "customer",
            resourceId: customerId,
            metadata: { found: false },
          });
          return { status: "not_found" as const };
        }

        const identities = await tx<
          Array<{
            id: string;
            provider: string;
            identity_type: string;
            external_id_ciphertext: string;
            status: string;
            first_seen_at: Date;
            last_seen_at: Date;
          }>
        >`
          SELECT
            id,
            provider,
            identity_type,
            external_id_ciphertext,
            status,
            first_seen_at,
            last_seen_at
          FROM retention_customer_identities
          WHERE org_id = ${context.organizationId}
            AND customer_id = ${customerId}
          ORDER BY first_seen_at, id
          LIMIT 100
        `;
        const traits = await tx<
          Array<{
            id: string;
            trait_key: string;
            value_ciphertext: string;
            value_type: string;
            evidence_kind: string;
            sensitivity: string;
            confidence: string;
            targeting_status: string;
            observed_at: Date;
            expires_at: Date | null;
          }>
        >`
          SELECT
            id,
            trait_key,
            value_ciphertext,
            value_type,
            evidence_kind,
            sensitivity,
            confidence::TEXT,
            targeting_status,
            observed_at,
            expires_at
          FROM retention_customer_traits
          WHERE org_id = ${context.organizationId}
            AND customer_id = ${customerId}
          ORDER BY observed_at, id
          LIMIT 500
        `;
        const consent = await tx<
          Array<{
            id: string;
            channel: string;
            state: string;
            source_provider: string;
            occurred_at: Date;
          }>
        >`
          SELECT id, channel, state, source_provider, occurred_at
          FROM retention_consent_events
          WHERE org_id = ${context.organizationId}
            AND customer_id = ${customerId}
          ORDER BY occurred_at, id
          LIMIT 500
        `;
        const sourceEvents = await tx<
          Array<{
            id: string;
            provider: string;
            event_type: string;
            processing_status: string;
            occurred_at: Date;
            ingested_at: Date;
            processed_at: Date | null;
          }>
        >`
          SELECT
            id,
            provider,
            event_type,
            processing_status,
            occurred_at,
            ingested_at,
            processed_at
          FROM retention_source_events
          WHERE org_id = ${context.organizationId}
            AND customer_id = ${customerId}
          ORDER BY occurred_at, id
          LIMIT 1000
        `;
        const decisions = await tx<
          Array<{
            id: string;
            program_id: string;
            status: string;
            objective: string | null;
            recommended_timing: Date | null;
            recommended_offer: unknown;
            reasoning_ciphertext: string | null;
            competing_hypotheses_ciphertext: string | null;
            sensitivity: string;
            confidence: string | null;
            reasoned_at: Date | null;
            invalidated_at: Date | null;
          }>
        >`
          SELECT
            id,
            program_id,
            status,
            objective,
            recommended_timing,
            recommended_offer,
            reasoning_ciphertext,
            competing_hypotheses_ciphertext,
            sensitivity,
            confidence::TEXT,
            reasoned_at,
            invalidated_at
          FROM retention_customer_decisions
          WHERE org_id = ${context.organizationId}
            AND customer_id = ${customerId}
          ORDER BY created_at, id
          LIMIT 250
        `;
        const messages = await tx<
          Array<{
            id: string;
            campaign_id: string;
            subject_ciphertext: string;
            preheader_ciphertext: string | null;
            body_ciphertext: string;
            offer_ciphertext: string | null;
            explanation_ciphertext: string;
            quality_status: string;
            generated_at: Date;
          }>
        >`
          SELECT
            id,
            campaign_id,
            subject_ciphertext,
            preheader_ciphertext,
            body_ciphertext,
            offer_ciphertext,
            explanation_ciphertext,
            quality_status,
            generated_at
          FROM retention_rendered_messages
          WHERE org_id = ${context.organizationId}
            AND customer_id = ${customerId}
          ORDER BY generated_at, id
          LIMIT 250
        `;
        const segmentMemberships = await tx<
          Array<{
            segment_definition_id: string;
            segment_run_id: string;
            campaign_eligible: boolean;
            eligibility_reason: string;
            evidence_cutoff_at: Date;
            evaluated_at: Date;
          }>
        >`
          SELECT
            segment_definition_id,
            segment_run_id,
            campaign_eligible,
            eligibility_reason,
            evidence_cutoff_at,
            evaluated_at
          FROM retention_segment_memberships
          WHERE org_id = ${context.organizationId}
            AND customer_id = ${customerId}
          ORDER BY evaluated_at, segment_definition_id
          LIMIT 500
        `;

        const exportValue = {
          schemaVersion: "worklin-retention-customer-export-v1",
          exportedAt: new Date().toISOString(),
          customer: {
            id: customerId,
            brandId: customer.brand_id,
            status: customer.status,
            email: customer.primary_email_ciphertext
              ? this.crypto.decrypt(
                  customer.primary_email_ciphertext,
                  `${context.organizationId}:customer:${customerId}:email`,
                )
              : null,
            phone: customer.primary_phone_ciphertext
              ? this.crypto.decrypt(
                  customer.primary_phone_ciphertext,
                  `${context.organizationId}:customer:${customerId}:phone`,
                )
              : null,
            displayName: this.decryptCustomerDisplayName(
              context.organizationId,
              customerId,
              customer.display_name_ciphertext,
            ),
            sourceUpdatedAt: customer.source_updated_at?.toISOString() ?? null,
            createdAt: customer.created_at.toISOString(),
            updatedAt: customer.updated_at.toISOString(),
          },
          identities: identities.map((identity) => ({
            provider: identity.provider,
            type: identity.identity_type,
            externalId: this.crypto.decrypt(
              identity.external_id_ciphertext,
              `${context.organizationId}:identity:${identity.id}:external`,
            ),
            status: identity.status,
            firstSeenAt: identity.first_seen_at.toISOString(),
            lastSeenAt: identity.last_seen_at.toISOString(),
          })),
          traits: traits.map((trait) => ({
            key: trait.trait_key,
            value: JSON.parse(
              this.crypto.decrypt(
                trait.value_ciphertext,
                `${context.organizationId}:trait:${trait.id}:value`,
              ),
            ),
            valueType: trait.value_type,
            evidenceKind: trait.evidence_kind,
            sensitivity: trait.sensitivity,
            confidence: Number(trait.confidence),
            targetingStatus: trait.targeting_status,
            observedAt: trait.observed_at.toISOString(),
            expiresAt: trait.expires_at?.toISOString() ?? null,
          })),
          consentHistory: consent.map((event) => ({
            id: event.id,
            channel: event.channel,
            state: event.state,
            sourceProvider: event.source_provider,
            occurredAt: event.occurred_at.toISOString(),
          })),
          sourceEventHistory: sourceEvents.map((event) => ({
            id: event.id,
            provider: event.provider,
            type: event.event_type,
            processingStatus: event.processing_status,
            occurredAt: event.occurred_at.toISOString(),
            ingestedAt: event.ingested_at.toISOString(),
            processedAt: event.processed_at?.toISOString() ?? null,
          })),
          decisions: decisions.map((decision) => ({
            id: decision.id,
            programId: decision.program_id,
            status: decision.status,
            objective: decision.objective,
            recommendedTiming:
              decision.recommended_timing?.toISOString() ?? null,
            recommendedOffer: decision.recommended_offer,
            reasoning: decision.reasoning_ciphertext
              ? JSON.parse(
                  this.crypto.decrypt(
                    decision.reasoning_ciphertext,
                    `${context.organizationId}:decision:${decision.id}:reasoning`,
                  ),
                )
              : null,
            competingHypotheses: decision.competing_hypotheses_ciphertext
              ? JSON.parse(
                  this.crypto.decrypt(
                    decision.competing_hypotheses_ciphertext,
                    `${context.organizationId}:decision:${decision.id}:hypotheses`,
                  ),
                )
              : null,
            sensitivity: decision.sensitivity,
            confidence:
              decision.confidence === null ? null : Number(decision.confidence),
            reasonedAt: decision.reasoned_at?.toISOString() ?? null,
            invalidatedAt: decision.invalidated_at?.toISOString() ?? null,
          })),
          messages: messages.map((message) => ({
            id: message.id,
            campaignId: message.campaign_id,
            subject: this.crypto.decrypt(
              message.subject_ciphertext,
              `${context.organizationId}:message:${message.id}:subject`,
            ),
            preheader: message.preheader_ciphertext
              ? this.crypto.decrypt(
                  message.preheader_ciphertext,
                  `${context.organizationId}:message:${message.id}:preheader`,
                )
              : null,
            body: this.crypto.decrypt(
              message.body_ciphertext,
              `${context.organizationId}:message:${message.id}:body`,
            ),
            offer: message.offer_ciphertext
              ? this.crypto.decrypt(
                  message.offer_ciphertext,
                  `${context.organizationId}:message:${message.id}:offer`,
                )
              : null,
            explanation: this.crypto.decrypt(
              message.explanation_ciphertext,
              `${context.organizationId}:message:${message.id}:explanation`,
            ),
            qualityStatus: message.quality_status,
            generatedAt: message.generated_at.toISOString(),
          })),
          segmentMemberships: segmentMemberships.map((membership) => ({
            segmentDefinitionId: membership.segment_definition_id,
            segmentRunId: membership.segment_run_id,
            campaignEligible: membership.campaign_eligible,
            eligibilityReason: membership.eligibility_reason,
            evidenceCutoffAt: membership.evidence_cutoff_at.toISOString(),
            evaluatedAt: membership.evaluated_at.toISOString(),
          })),
        };
        const byteLength = jsonByteLength(exportValue);
        await this.audit(tx, context, {
          action: "customer.privacy_export_requested",
          resourceType: "customer",
          resourceId: customerId,
          metadata: {
            found: true,
            bounded: byteLength <= MAX_PRIVACY_EXPORT_BYTES,
            byteLength,
          },
        });
        return byteLength <= MAX_PRIVACY_EXPORT_BYTES
          ? { status: "ready" as const, value: exportValue }
          : { status: "too_large" as const };
      },
    );
    if (result.status === "not_found") {
      throw new RetentionServiceError(
        "customer_not_found",
        "The retention customer was not found.",
        404,
      );
    }
    if (result.status === "too_large") {
      throw new RetentionServiceError(
        "privacy_export_too_large",
        "The customer export exceeds the bounded response limit.",
        413,
      );
    }
    return result.value;
  }

  async customerConsentHistory(
    context: TenantContext,
    input: { customerId: string; limit: number },
  ): Promise<{
    customerId: string;
    events: Array<{
      id: string;
      channel: string;
      state: string;
      sourceProvider: string;
      occurredAt: string;
    }>;
  }> {
    assertUuid(input.customerId, "customerId");
    return this.customerConsentHistoryWithinTenant(context, input);
  }

  private async customerConsentHistoryWithinTenant(
    context: TenantContext,
    input: { customerId: string; limit: number },
  ): Promise<{
    customerId: string;
    events: Array<{
      id: string;
      channel: string;
      state: string;
      sourceProvider: string;
      occurredAt: string;
    }>;
  }> {
    const result = await this.database.withTenant(
      context.organizationId,
      async (tx) => {
        const customers = await tx<Array<{ id: string }>>`
          SELECT id
          FROM retention_customers
          WHERE org_id = ${context.organizationId}
            AND id = ${input.customerId}
            AND status <> 'deleted'
        `;
        const found = Boolean(customers[0]);
        const rows = found
          ? await tx<
              Array<{
                id: string;
                channel: string;
                state: string;
                source_provider: string;
                occurred_at: Date;
              }>
            >`
              SELECT id, channel, state, source_provider, occurred_at
              FROM retention_consent_events
              WHERE org_id = ${context.organizationId}
                AND customer_id = ${input.customerId}
              ORDER BY occurred_at DESC, created_at DESC, id
              LIMIT ${input.limit}
            `
          : [];
        await this.audit(tx, context, {
          action: "customer.consent_history_viewed",
          resourceType: "customer",
          resourceId: input.customerId,
          metadata: { found, returnedCount: rows.length },
        });
        if (!found) return null;
        return {
          customerId: input.customerId,
          events: rows.map((row) => ({
            id: row.id,
            channel: row.channel,
            state: row.state,
            sourceProvider: row.source_provider,
            occurredAt: row.occurred_at.toISOString(),
          })),
        };
      },
    );
    if (!result) {
      throw new RetentionServiceError(
        "customer_not_found",
        "The retention customer was not found.",
        404,
      );
    }
    return result;
  }

  async correctCustomer(
    context: TenantContext,
    input: {
      customerId: string;
      email?: string | null;
      phone?: string | null;
      displayName?: string | null;
      reason: string;
    },
  ): Promise<{
    customerId: string;
    status: "corrected";
    changedFields: string[];
  }> {
    assertUuid(input.customerId, "customerId");
    const hasEmail = Object.prototype.hasOwnProperty.call(input, "email");
    const hasPhone = Object.prototype.hasOwnProperty.call(input, "phone");
    const hasDisplayName = Object.prototype.hasOwnProperty.call(
      input,
      "displayName",
    );
    const changedFields = [
      ...(hasEmail ? ["email"] : []),
      ...(hasPhone ? ["phone"] : []),
      ...(hasDisplayName ? ["displayName"] : []),
    ];
    if (changedFields.length === 0) {
      throw new RetentionServiceError(
        "customer_correction_empty",
        "At least one customer field must be corrected.",
        400,
      );
    }
    const normalizedEmail =
      hasEmail && input.email !== null && input.email !== undefined
        ? normalizeEmail(input.email)
        : null;
    const normalizedPhone =
      hasPhone && input.phone !== null && input.phone !== undefined
        ? normalizePhone(input.phone)
        : null;
    if (hasPhone && input.phone && !normalizedPhone) {
      throw new RetentionServiceError(
        "customer_phone_invalid",
        "The corrected phone number is invalid.",
        400,
      );
    }
    const displayName =
      hasDisplayName &&
      input.displayName !== null &&
      input.displayName !== undefined
        ? input.displayName.trim()
        : null;
    try {
      const found = await this.database.withTenant(
        context.organizationId,
        async (tx) => {
          const customers = await tx<Array<{ brand_id: string }>>`
            SELECT brand_id
            FROM retention_customers
            WHERE org_id = ${context.organizationId}
              AND id = ${input.customerId}
              AND status <> 'deleted'
            FOR UPDATE
          `;
          const customer = customers[0];
          if (!customer) {
            await this.audit(tx, context, {
              action: "customer.correction_requested",
              resourceType: "customer",
              resourceId: input.customerId,
              metadata: { found: false, changedFields },
            });
            return false;
          }
          await tx`
            UPDATE retention_customers
            SET
              primary_email_ciphertext = CASE
                WHEN ${hasEmail} THEN ${
                  normalizedEmail
                    ? this.crypto.encrypt(
                        normalizedEmail,
                        `${context.organizationId}:customer:${input.customerId}:email`,
                      )
                    : null
                }
                ELSE primary_email_ciphertext
              END,
              primary_email_blind_index = CASE
                WHEN ${hasEmail} THEN ${
                  normalizedEmail
                    ? this.crypto.blindIndex(
                        normalizedEmail,
                        `${context.organizationId}:${customer.brand_id}:email`,
                      )
                    : null
                }
                ELSE primary_email_blind_index
              END,
              primary_phone_ciphertext = CASE
                WHEN ${hasPhone} THEN ${
                  normalizedPhone
                    ? this.crypto.encrypt(
                        normalizedPhone,
                        `${context.organizationId}:customer:${input.customerId}:phone`,
                      )
                    : null
                }
                ELSE primary_phone_ciphertext
              END,
              primary_phone_blind_index = CASE
                WHEN ${hasPhone} THEN ${
                  normalizedPhone
                    ? this.crypto.blindIndex(
                        normalizedPhone,
                        `${context.organizationId}:${customer.brand_id}:phone`,
                      )
                    : null
                }
                ELSE primary_phone_blind_index
              END,
              display_name_ciphertext = CASE
                WHEN ${hasDisplayName} THEN ${
                  displayName
                    ? this.crypto.encrypt(
                        displayName,
                        `${context.organizationId}:customer:${input.customerId}:name`,
                      )
                    : null
                }
                ELSE display_name_ciphertext
              END,
              source_updated_at = now(),
              updated_at = now()
            WHERE org_id = ${context.organizationId}
              AND id = ${input.customerId}
          `;
          await tx`
            UPDATE retention_feature_snapshots
            SET invalidated_at = now()
            WHERE org_id = ${context.organizationId}
              AND customer_id = ${input.customerId}
              AND invalidated_at IS NULL
          `;
          await tx`
            UPDATE retention_customer_decisions
            SET
              status = 'expired',
              invalidated_at = now(),
              updated_at = now()
            WHERE org_id = ${context.organizationId}
              AND customer_id = ${input.customerId}
              AND invalidated_at IS NULL
          `;
          await tx`
            UPDATE retention_approvals AS approval
            SET status = 'invalidated', invalidated_at = now()
            WHERE approval.org_id = ${context.organizationId}
              AND approval.status = 'approved'
              AND EXISTS (
                SELECT 1
                FROM retention_audience_snapshots AS audience
                JOIN retention_audience_members AS member
                  ON member.org_id = audience.org_id
                  AND member.audience_snapshot_id = audience.id
                WHERE audience.org_id = approval.org_id
                  AND audience.campaign_id = approval.campaign_id
                  AND member.customer_id = ${input.customerId}
              )
          `;
          await tx`
            UPDATE retention_campaigns AS campaign
            SET status = 'review_required', updated_at = now()
            WHERE campaign.org_id = ${context.organizationId}
              AND campaign.status IN (
                'audience_frozen',
                'generating',
                'review_required',
                'approved',
                'ready_to_send',
                'failed'
              )
              AND EXISTS (
                SELECT 1
                FROM retention_audience_snapshots AS audience
                JOIN retention_audience_members AS member
                  ON member.org_id = audience.org_id
                  AND member.audience_snapshot_id = audience.id
                WHERE audience.org_id = campaign.org_id
                  AND audience.campaign_id = campaign.id
                  AND member.customer_id = ${input.customerId}
              )
          `;
          await tx`
            DELETE FROM retention_rendered_messages AS message
            USING retention_campaigns AS campaign
            WHERE message.org_id = ${context.organizationId}
              AND message.customer_id = ${input.customerId}
              AND campaign.org_id = message.org_id
              AND campaign.id = message.campaign_id
              AND campaign.status NOT IN (
                'sending',
                'sent',
                'partially_sent'
              )
          `;
          await tx`
            UPDATE retention_dispatch_recipients
            SET
              content_ciphertext = NULL,
              status = CASE
                WHEN status IN ('pending', 'failed') THEN 'cancelled'
                ELSE status
              END,
              updated_at = now()
            WHERE org_id = ${context.organizationId}
              AND customer_id = ${input.customerId}
              AND status <> 'accepted'
          `;
          await this.audit(tx, context, {
            action: "customer.corrected",
            resourceType: "customer",
            resourceId: input.customerId,
            metadata: {
              changedFields,
              reasonSha256: sha256(input.reason.trim()),
            },
          });
          return true;
        },
      );
      if (!found) {
        throw new RetentionServiceError(
          "customer_not_found",
          "The retention customer was not found.",
          404,
        );
      }
    } catch (error) {
      if (
        error instanceof RetentionServiceError &&
        error.code === "customer_not_found"
      ) {
        throw error;
      }
      const databaseError =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      await this.auditPrivacyFailure(context, {
        action: "customer.correction_failed",
        resourceType: "customer",
        resourceId: input.customerId,
        errorCode:
          databaseError === "23505"
            ? "customer_identity_conflict"
            : "customer_correction_failed",
      });
      if (databaseError === "23505") {
        throw new RetentionServiceError(
          "customer_identity_conflict",
          "The corrected identifier is already assigned to another customer.",
          409,
        );
      }
      throw error;
    }
    return {
      customerId: input.customerId,
      status: "corrected",
      changedFields,
    };
  }

  async deleteCustomer(
    context: TenantContext,
    input: { customerId: string; idempotencyKey: string; reason: string },
  ): Promise<{
    customerId: string;
    status: "deleted";
    rawPayloadsDeleted: number;
    duplicate: boolean;
  }> {
    assertUuid(input.customerId, "customerId");
    try {
      const result = await this.database.withTenant(
        context.organizationId,
        async (tx) => {
          const customers = await tx<
            Array<{
              brand_id: string;
              status: string;
            }>
          >`
            SELECT brand_id, status
            FROM retention_customers
            WHERE org_id = ${context.organizationId}
              AND id = ${input.customerId}
            FOR UPDATE
          `;
          const customer = customers[0];
          if (!customer) {
            await this.audit(tx, context, {
              action: "customer.deletion_requested",
              resourceType: "customer",
              resourceId: input.customerId,
              metadata: { found: false },
            });
            return { status: "not_found" as const };
          }
          const requests = await tx<
            Array<{ id: string; status: string; raw_payload_count: string }>
          >`
            SELECT id, status, raw_payload_count::TEXT
            FROM retention_privacy_requests
            WHERE org_id = ${context.organizationId}
              AND customer_id = ${input.customerId}
              AND request_type = 'deletion'
              AND idempotency_key = ${input.idempotencyKey}
          `;
          const existing = requests[0];
          if (existing?.status === "completed") {
            await this.audit(tx, context, {
              action: "customer.deletion_replayed",
              resourceType: "customer",
              resourceId: input.customerId,
              metadata: { duplicate: true },
            });
            return {
              status: "deleted" as const,
              rawPayloadsDeleted: Number(existing?.raw_payload_count ?? 0),
              duplicate: true,
            };
          }
          if (customer.status === "deleted" && !existing) {
            await this.audit(tx, context, {
              action: "customer.deletion_replayed",
              resourceType: "customer",
              resourceId: input.customerId,
              metadata: { duplicate: true, legacyRequest: true },
            });
            return {
              status: "deleted" as const,
              rawPayloadsDeleted: 0,
              duplicate: true,
            };
          }
          const requestId = existing?.id ?? randomUUID();
          if (!existing) {
            await tx`
              INSERT INTO retention_privacy_requests (
                id,
                org_id,
                customer_id,
                request_type,
                idempotency_key,
                status,
                requested_by,
                assistant_id,
                request_id
              )
              VALUES (
                ${requestId},
                ${context.organizationId},
                ${input.customerId},
                'deletion',
                ${input.idempotencyKey},
                'processing',
                ${context.userId},
                ${context.assistantId},
                ${context.requestId}
              )
            `;
          }
          const erased =
            customer.status === "deleted"
              ? null
              : await this.eraseCustomer(
                  tx,
                  context.organizationId,
                  input.customerId,
                  undefined,
                  requestId,
                );
          const deletionRows = await tx<Array<{ id: string }>>`
            SELECT id
            FROM retention_raw_payload_deletions
            WHERE org_id = ${context.organizationId}
              AND privacy_request_id = ${requestId}
            ORDER BY created_at, id
          `;
          const rawPayloadCount =
            erased?.rawPayloadsDeleted ??
            Number(existing?.raw_payload_count ?? deletionRows.length);
          await tx`
            UPDATE retention_privacy_requests
            SET
              status = 'processing',
              raw_payload_count = ${rawPayloadCount},
              completed_at = NULL
            WHERE org_id = ${context.organizationId}
              AND id = ${requestId}
          `;
          await this.audit(tx, context, {
            action: "customer.deletion_staged",
            resourceType: "customer",
            resourceId: input.customerId,
            metadata: {
              rawPayloadsQueued: rawPayloadCount,
              reasonSha256: sha256(input.reason.trim()),
            },
          });
          return {
            status: "processing" as const,
            requestId,
            deletionIds: deletionRows.map((row) => row.id),
            rawPayloadCount,
            duplicate: Boolean(existing),
          };
        },
      );
      if (result.status === "not_found") {
        throw new RetentionServiceError(
          "customer_not_found",
          "The retention customer was not found.",
          404,
        );
      }
      if (result.status === "deleted") {
        return {
          customerId: input.customerId,
          ...result,
        };
      }
      for (const deletionId of result.deletionIds) {
        await this.processRawPayloadDeletion(
          context.organizationId,
          deletionId,
        );
      }
      const completed = await this.database.withTenant(
        context.organizationId,
        async (tx) => {
          const pending = await tx<Array<{ count: string }>>`
            SELECT count(*)::TEXT AS count
            FROM retention_raw_payload_deletions
            WHERE org_id = ${context.organizationId}
              AND privacy_request_id = ${result.requestId}
              AND status <> 'deleted'
          `;
          if (Number(pending[0]?.count ?? 0) > 0) {
            throw new RetentionServiceError(
              "raw_payload_deletion_incomplete",
              "Customer deletion is waiting for raw-payload cleanup.",
              503,
            );
          }
          await tx`
            UPDATE retention_privacy_requests
            SET
              status = 'completed',
              completed_at = now()
            WHERE org_id = ${context.organizationId}
              AND id = ${result.requestId}
              AND status = 'processing'
          `;
          await this.audit(tx, context, {
            action: "customer.deleted",
            resourceType: "customer",
            resourceId: input.customerId,
            metadata: {
              rawPayloadsDeleted: result.rawPayloadCount,
              reasonSha256: sha256(input.reason.trim()),
            },
          });
          return {
            status: "deleted" as const,
            rawPayloadsDeleted: result.rawPayloadCount,
            duplicate: result.duplicate,
          };
        },
      );
      return {
        customerId: input.customerId,
        ...completed,
      };
    } catch (error) {
      if (
        error instanceof RetentionServiceError &&
        error.code === "customer_not_found"
      ) {
        throw error;
      }
      await this.auditPrivacyFailure(context, {
        action: "customer.deletion_failed",
        resourceType: "customer",
        resourceId: input.customerId,
        errorCode: "customer_deletion_failed",
      });
      throw error;
    }
  }

  async revokeIntegration(
    context: TenantContext,
    input: { integrationId: string; reason: string },
  ): Promise<{
    integrationId: string;
    provider: "shopify" | "klaviyo";
    status: "revoked";
    duplicate: boolean;
  }> {
    assertUuid(input.integrationId, "integrationId");
    const result = await this.database.withTenant(
      context.organizationId,
      async (tx) => {
        const integrations = await tx<
          Array<{
            provider: "shopify" | "klaviyo";
            status: string;
          }>
        >`
          SELECT provider, status
          FROM retention_integrations
          WHERE org_id = ${context.organizationId}
            AND id = ${input.integrationId}
          FOR UPDATE
        `;
        const integration = integrations[0];
        if (!integration) {
          await this.audit(tx, context, {
            action: "integration.revocation_requested",
            resourceType: "integration",
            resourceId: input.integrationId,
            metadata: { found: false },
          });
          return null;
        }
        const duplicate = integration.status === "revoked";
        if (!duplicate) {
          await tx`
            UPDATE retention_integrations
            SET
              status = 'revoked',
              credential_ciphertext = NULL,
              webhook_secret_ciphertext = NULL,
              cursor = '{}'::JSONB,
              last_error_code = NULL,
              last_error_message = NULL,
              updated_at = now()
            WHERE org_id = ${context.organizationId}
              AND id = ${input.integrationId}
          `;
          await tx`
            UPDATE retention_migration_runs
            SET
              status = 'cancelled',
              completed_at = COALESCE(completed_at, now()),
              updated_at = now()
            WHERE org_id = ${context.organizationId}
              AND integration_id = ${input.integrationId}
              AND status IN (
                'preview',
                'approved',
                'running',
                'paused'
              )
          `;
          await tx`
            UPDATE retention_source_events
            SET processing_status = 'ignored', processed_at = now()
            WHERE org_id = ${context.organizationId}
              AND integration_id = ${input.integrationId}
              AND processing_status IN ('pending', 'processing')
          `;
        }
        await this.audit(tx, context, {
          action: duplicate
            ? "integration.revocation_replayed"
            : "integration.revoked",
          resourceType: "integration",
          resourceId: input.integrationId,
          metadata: {
            provider: integration.provider,
            duplicate,
            reasonSha256: sha256(input.reason.trim()),
          },
        });
        return {
          integrationId: input.integrationId,
          provider: integration.provider,
          status: "revoked" as const,
          duplicate,
        };
      },
    );
    if (!result) {
      throw new RetentionServiceError(
        "integration_not_found",
        "The retention integration is unavailable.",
        404,
      );
    }
    return result;
  }

  async createBrand(
    context: TenantContext,
    input: { name: string; websiteUrl?: string; metadata?: unknown },
  ): Promise<{ id: string; name: string }> {
    const id = randomUUID();
    await this.database.withTenant(context.organizationId, async (tx) => {
      await tx`
        INSERT INTO retention_brands (
          id,
          org_id,
          name,
          website_url,
          metadata
        )
        VALUES (
          ${id},
          ${context.organizationId},
          ${input.name.trim()},
          ${input.websiteUrl ?? null},
          ${tx.json(JSON.parse(canonicalJson(input.metadata ?? {})))}
        )
      `;
      await this.audit(tx, context, {
        action: "brand.created",
        resourceType: "brand",
        resourceId: id,
      });
    });
    return { id, name: input.name.trim() };
  }

  async createIntegration(
    context: TenantContext,
    input: {
      brandId: string;
      provider: "shopify" | "klaviyo";
      controlPlaneConnectionId: string;
      externalAccountId?: string;
      credential?: string;
      webhookSecret: string;
      propertyAccessMode?: KlaviyoPropertyAccessMode;
      propertyAllowlist?: string[];
    },
  ): Promise<{
    id: string;
    provider: "shopify" | "klaviyo";
    webhookRouteToken: string;
    migrationRunId: string;
  }> {
    assertUuid(input.brandId, "brandId");
    const id = randomUUID();
    const migrationRunId = randomUUID();
    const propertyAccessMode =
      input.provider === "klaviyo"
        ? (input.propertyAccessMode ?? "allowlist")
        : "allowlist";
    if (input.provider === "klaviyo" && input.credential) {
      try {
        const client = new KlaviyoProviderSyncClient({
          privateApiKey: input.credential,
          propertyAccessMode,
          propertyAllowlist: input.propertyAllowlist ?? [],
          fetch:
            this.options.providerFetch ?? globalThis.fetch.bind(globalThis),
        });
        await client.historicalBackfillPage({
          integrationId: id,
          resource: "profiles",
          pageSize: 1,
        });
      } catch (error) {
        if (error instanceof ProviderSyncError) {
          const code =
            error.status === 401
              ? "klaviyo_credentials_rejected"
              : error.status === 403
                ? "klaviyo_read_scope_required"
                : error.code;
          throw new RetentionServiceError(
            code,
            error.status === 401
              ? "Klaviyo rejected the private API key."
              : error.status === 403
                ? "The Klaviyo key needs read access to profiles."
                : error.message,
            error.status,
            Object.keys(error.rateLimit).length > 0
              ? { rateLimit: error.rateLimit }
              : undefined,
          );
        }
        throw error;
      }
    }
    const credentialCiphertext = input.credential
      ? this.crypto.encrypt(
          input.credential,
          `${context.organizationId}:integration:${id}:credential`,
        )
      : null;
    const webhookSecretCiphertext = this.crypto.encrypt(
      input.webhookSecret,
      `${context.organizationId}:integration:${id}:webhook-secret`,
    );
    await this.database.withTenant(context.organizationId, async (tx) => {
      await tx`
        INSERT INTO retention_integrations (
          id,
          org_id,
          brand_id,
          provider,
          status,
          control_plane_connection_id,
          external_account_id,
          credential_ciphertext,
          webhook_secret_ciphertext,
          property_access_mode,
          property_allowlist
        )
        VALUES (
          ${id},
          ${context.organizationId},
          ${input.brandId},
          ${input.provider},
          'pending',
          ${input.controlPlaneConnectionId},
          ${input.externalAccountId ?? null},
          ${credentialCiphertext},
          ${webhookSecretCiphertext},
          ${propertyAccessMode},
          ${tx.json(input.propertyAllowlist ?? [])}
        )
      `;
      await tx`
        INSERT INTO retention_migration_runs (
          id,
          org_id,
          integration_id,
          status,
          manifest,
          checkpoint
        )
        VALUES (
          ${migrationRunId},
          ${context.organizationId},
          ${id},
          'preview',
          ${tx.json({
            provider: input.provider,
            lifecycle: "historical_backfill",
            resources: [...PROVIDER_SYNC_RESOURCES[input.provider]],
            approvedPropertyAllowlist:
              input.provider === "klaviyo"
                ? (input.propertyAllowlist ?? [])
                : [],
            approvedPropertyAccessMode: propertyAccessMode,
            externalWrites: false,
          })},
          '{}'::JSONB
        )
      `;
      await this.audit(tx, context, {
        action: "integration.created",
        resourceType: "integration",
        resourceId: id,
        metadata: { provider: input.provider, migrationRunId },
      });
    });
    return {
      id,
      provider: input.provider,
      webhookRouteToken: this.crypto.sealRoute({
        organizationId: context.organizationId,
        integrationId: id,
        provider: input.provider,
      }),
      migrationRunId,
    };
  }

  async approveImport(
    context: TenantContext,
    input: { migrationRunId: string },
  ): Promise<{
    migrationRunId: string;
    integrationId: string;
    status: "running";
    duplicate: boolean;
  }> {
    assertUuid(input.migrationRunId, "migrationRunId");
    if (
      !context.permissions.includes("retention:integrations") &&
      !context.permissions.includes("retention:*")
    ) {
      throw new RetentionServiceError(
        "integration_permission_required",
        "Retention integration permission is required.",
        403,
      );
    }
    return this.database.withTenant(context.organizationId, async (tx) => {
      const rows = await tx<
        Array<{
          integration_id: string;
          migration_status: string;
          integration_status: string;
          provider: "shopify" | "klaviyo";
          external_account_id: string | null;
          credential_ciphertext: string | null;
          cursor: unknown;
        }>
      >`
        SELECT
          migration.integration_id,
          migration.status AS migration_status,
          integration.status AS integration_status,
          integration.provider,
          integration.external_account_id,
          integration.credential_ciphertext,
          integration.cursor
        FROM retention_migration_runs AS migration
        JOIN retention_integrations AS integration
          ON integration.org_id = migration.org_id
          AND integration.id = migration.integration_id
        WHERE migration.org_id = ${context.organizationId}
          AND migration.id = ${input.migrationRunId}
        FOR UPDATE OF migration, integration
      `;
      const row = rows[0];
      if (!row || row.integration_status === "revoked") {
        throw new RetentionServiceError(
          "import_not_found",
          "The retention import is unavailable.",
          404,
        );
      }
      if (
        !row.credential_ciphertext ||
        (row.provider === "shopify" && !row.external_account_id)
      ) {
        throw new RetentionServiceError(
          "live_data_required",
          "A live provider connection is required before import.",
          409,
        );
      }
      if (row.migration_status === "completed") {
        throw new RetentionServiceError(
          "import_already_completed",
          "The retention import has already completed.",
          409,
        );
      }
      const duplicate = row.migration_status === "running";
      if (!duplicate) {
        const cursor = parseProviderCursor(row.cursor);
        cursor.historical_backfill = Object.fromEntries(
          PROVIDER_SYNC_RESOURCES[row.provider].map((resource) => [
            resource,
            cursor.historical_backfill?.[resource] ?? emptyProviderSyncState(),
          ]),
        );
        await tx`
          UPDATE retention_integrations
          SET
            status = 'backfilling',
            cursor = ${tx.json(JSON.parse(canonicalJson(cursor)))},
            last_error_code = NULL,
            last_error_message = NULL,
            updated_at = now()
          WHERE org_id = ${context.organizationId}
            AND id = ${row.integration_id}
        `;
        await tx`
          UPDATE retention_migration_runs
          SET
            status = 'running',
            checkpoint = ${tx.json(
              JSON.parse(canonicalJson(cursor.historical_backfill)),
            )},
            approved_by = ${context.userId},
            approved_at = COALESCE(approved_at, now()),
            started_at = COALESCE(started_at, now()),
            last_error_code = NULL,
            updated_at = now()
          WHERE org_id = ${context.organizationId}
            AND id = ${input.migrationRunId}
        `;
        await this.audit(tx, context, {
          action: "import.approved",
          resourceType: "migration_run",
          resourceId: input.migrationRunId,
          metadata: {
            integrationId: row.integration_id,
            provider: row.provider,
          },
        });
      }
      return {
        migrationRunId: input.migrationRunId,
        integrationId: row.integration_id,
        status: "running",
        duplicate,
      };
    });
  }

  async scheduleTenantSyncs(organizationId: string): Promise<void> {
    await this.database.withTenant(organizationId, async (tx) => {
      const integrations = await tx<
        Array<{
          id: string;
          provider: "shopify" | "klaviyo";
          status: "backfilling" | "active";
          cursor: unknown;
          last_polled_at: Date | null;
          last_reconciled_at: Date | null;
          migration_run_id: string | null;
        }>
      >`
        SELECT
          integration.id,
          integration.provider,
          integration.status,
          integration.cursor,
          integration.last_polled_at,
          integration.last_reconciled_at,
          migration.id AS migration_run_id
        FROM retention_integrations AS integration
        LEFT JOIN LATERAL (
          SELECT id
          FROM retention_migration_runs
          WHERE org_id = integration.org_id
            AND integration_id = integration.id
            AND status = 'running'
          ORDER BY created_at
          LIMIT 1
        ) AS migration ON true
        WHERE integration.org_id = ${organizationId}
          AND integration.status IN ('backfilling', 'active')
        ORDER BY integration.created_at, integration.id
      `;

      for (const integration of integrations) {
        const cursor = parseProviderCursor(integration.cursor);
        const lifecycles: ProviderSyncLifecycle[] = [];
        if (
          integration.status === "backfilling" &&
          integration.migration_run_id
        ) {
          lifecycles.push("historical_backfill");
        }
        if (integration.status === "active") {
          const pollDue =
            integration.last_polled_at === null ||
            integration.last_polled_at.getTime() <= Date.now() - 5 * 60_000;
          const reconcileDue =
            integration.last_reconciled_at === null ||
            integration.last_reconciled_at.getTime() <=
              Date.now() - 60 * 60_000;
          const pollIncomplete = Object.values(
            cursor.incremental_poll ?? {},
          ).some((state) => state?.completed === false);
          const reconcileIncomplete = Object.values(
            cursor.reconciliation ?? {},
          ).some((state) => state?.completed === false);
          if (pollDue || pollIncomplete) lifecycles.push("incremental_poll");
          if (reconcileDue || reconcileIncomplete) {
            lifecycles.push("reconciliation");
          }
        }

        for (const lifecycle of lifecycles) {
          const resources = PROVIDER_SYNC_RESOURCES[integration.provider];
          let lifecycleState = cursor[lifecycle] ?? {};
          const priorStates = resources
            .map((resource) => lifecycleState[resource])
            .filter(
              (state): state is ProviderResourceSyncState =>
                state !== undefined,
            );
          if (
            lifecycle !== "historical_backfill" &&
            priorStates.length === resources.length &&
            priorStates.every((state) => state.completed)
          ) {
            lifecycleState = Object.fromEntries(
              resources.map((resource) => [
                resource,
                {
                  cursor: null,
                  watermark: lifecycleState[resource]?.watermark ?? null,
                  completed: false,
                },
              ]),
            );
          }
          for (const resource of resources) {
            lifecycleState[resource] ??= emptyProviderSyncState();
            if (lifecycleState[resource]!.completed) continue;
            const jobId = randomUUID();
            await this.enqueueJob(tx, organizationId, {
              id: jobId,
              type: "sync_provider_page",
              dedupeKey: `${integration.id}:${lifecycle}:${resource}`,
              payload: {
                integrationId: integration.id,
                ...(lifecycle === "historical_backfill"
                  ? { migrationRunId: integration.migration_run_id! }
                  : {}),
                lifecycle,
                resource,
              } satisfies ProviderSyncJobPayload,
            });
          }
          cursor[lifecycle] = lifecycleState;
        }
        await tx`
          UPDATE retention_integrations
          SET
            cursor = ${tx.json(JSON.parse(canonicalJson(cursor)))},
            updated_at = now()
          WHERE org_id = ${organizationId}
            AND id = ${integration.id}
        `;
      }
    });
  }

  async processProviderSyncPage(
    organizationId: string,
    payload: ProviderSyncJobPayload,
  ): Promise<{
    integrationId: string;
    lifecycle: ProviderSyncLifecycle;
    resource: ProviderSyncResource;
    appendedCount: number;
    duplicateCount: number;
    completed: boolean;
  }> {
    assertUuid(payload.integrationId, "integrationId");
    if (payload.migrationRunId) {
      assertUuid(payload.migrationRunId, "migrationRunId");
    }
    if (
      !["historical_backfill", "incremental_poll", "reconciliation"].includes(
        payload.lifecycle,
      )
    ) {
      throw new RetentionServiceError(
        "invalid_job_payload",
        "The provider synchronization lifecycle is invalid.",
        422,
      );
    }
    const integration = await this.database.withTenant(
      organizationId,
      async (tx) => {
        const rows = await tx<
          Array<{
            provider: "shopify" | "klaviyo";
            status: string;
            external_account_id: string | null;
            credential_ciphertext: string | null;
            property_access_mode: KlaviyoPropertyAccessMode;
            property_allowlist: unknown;
            cursor: unknown;
          }>
        >`
          SELECT
            provider,
            status,
            external_account_id,
            credential_ciphertext,
            property_access_mode,
            property_allowlist,
            cursor
          FROM retention_integrations
          WHERE org_id = ${organizationId}
            AND id = ${payload.integrationId}
            AND status IN ('backfilling', 'active', 'degraded', 'failed')
        `;
        return rows[0] ?? null;
      },
    );
    if (!integration?.credential_ciphertext) {
      throw new RetentionServiceError(
        "live_data_required",
        "A live provider connection is required for synchronization.",
        409,
      );
    }
    if (
      !PROVIDER_SYNC_RESOURCES[integration.provider].includes(
        payload.resource as never,
      )
    ) {
      throw new RetentionServiceError(
        "invalid_job_payload",
        "The provider synchronization resource is invalid.",
        422,
      );
    }
    const cursor = parseProviderCursor(integration.cursor);
    const checkpoint =
      cursor[payload.lifecycle]?.[payload.resource] ?? emptyProviderSyncState();
    const credential = this.crypto.decrypt(
      integration.credential_ciphertext,
      `${organizationId}:integration:${payload.integrationId}:credential`,
    );
    const fetchImplementation =
      this.options.providerFetch ?? globalThis.fetch.bind(globalThis);

    try {
      const page =
        integration.provider === "shopify"
          ? await (() => {
              if (!integration.external_account_id) {
                throw new RetentionServiceError(
                  "live_data_required",
                  "The Shopify store domain is required for synchronization.",
                  409,
                );
              }
              const client = new ShopifyProviderSyncClient({
                shopDomain: integration.external_account_id,
                accessToken: credential,
                fetch: fetchImplementation,
              });
              const input = {
                integrationId: payload.integrationId,
                resource: payload.resource as "customers" | "orders",
                checkpoint,
              };
              if (payload.lifecycle === "historical_backfill") {
                return client.historicalBackfillPage(input);
              }
              if (payload.lifecycle === "incremental_poll") {
                return client.incrementalPollPage(input);
              }
              return client.reconciliationPage(input);
            })()
          : await (() => {
              const allowlist = Array.isArray(integration.property_allowlist)
                ? integration.property_allowlist.filter(
                    (value): value is string => typeof value === "string",
                  )
                : [];
              const client = new KlaviyoProviderSyncClient({
                privateApiKey: credential,
                propertyAccessMode: integration.property_access_mode,
                propertyAllowlist: allowlist,
                fetch: fetchImplementation,
              });
              const input = {
                integrationId: payload.integrationId,
                resource: payload.resource as "profiles" | "events",
                checkpoint,
              };
              if (payload.lifecycle === "historical_backfill") {
                return client.historicalBackfillPage(input);
              }
              if (payload.lifecycle === "incremental_poll") {
                return client.incrementalPollPage(input);
              }
              return client.reconciliationPage(input);
            })();

      let appendedCount = 0;
      let duplicateCount = 0;
      const rejectedCount = page.rejectedCount ?? 0;
      for (
        let offset = 0;
        offset < page.events.length;
        offset += PROVIDER_PAGE_INGEST_CONCURRENCY
      ) {
        const results = await Promise.all(
          page.events
            .slice(offset, offset + PROVIDER_PAGE_INGEST_CONCURRENCY)
            .map((event) =>
              this.appendSourceEvent(organizationId, {
                ...event,
                integrationId: payload.integrationId,
                provider: integration.provider,
                signatureVerified: false,
                ingestionChannel: "provider_sync",
              }),
            ),
        );
        for (const result of results) {
          if (result.duplicate) duplicateCount += 1;
          else appendedCount += 1;
        }
      }

      await this.database.withTenant(organizationId, async (tx) => {
        const latestRows = await tx<Array<{ cursor: unknown }>>`
          SELECT cursor
          FROM retention_integrations
          WHERE org_id = ${organizationId}
            AND id = ${payload.integrationId}
          FOR UPDATE
        `;
        const latestCursor = parseProviderCursor(latestRows[0]?.cursor);
        const lifecycleState = latestCursor[payload.lifecycle] ?? {};
        lifecycleState[payload.resource] = {
          ...page.checkpoint,
          completed: !page.hasMore,
        };
        latestCursor[payload.lifecycle] = lifecycleState;
        const resources = PROVIDER_SYNC_RESOURCES[integration.provider];
        const lifecycleCompleted = resources.every(
          (resource) => lifecycleState[resource]?.completed === true,
        );
        await tx`
          UPDATE retention_integrations
          SET
            cursor = ${tx.json(JSON.parse(canonicalJson(latestCursor)))},
            status = CASE
              WHEN ${payload.lifecycle} = 'historical_backfill'
                AND ${lifecycleCompleted} THEN 'active'
              WHEN status IN ('degraded', 'failed') THEN
                CASE
                  WHEN ${payload.lifecycle} = 'historical_backfill'
                    THEN 'backfilling'
                  ELSE 'active'
                END
              ELSE status
            END,
            last_polled_at = CASE
              WHEN ${payload.lifecycle} = 'incremental_poll'
                AND ${lifecycleCompleted} THEN now()
              WHEN ${payload.lifecycle} = 'historical_backfill'
                AND ${lifecycleCompleted} THEN now()
              ELSE last_polled_at
            END,
            last_reconciled_at = CASE
              WHEN ${payload.lifecycle} = 'reconciliation'
                AND ${lifecycleCompleted} THEN now()
              WHEN ${payload.lifecycle} = 'historical_backfill'
                AND ${lifecycleCompleted} THEN now()
              ELSE last_reconciled_at
            END,
            last_error_code = NULL,
            last_error_message = NULL,
            updated_at = now()
          WHERE org_id = ${organizationId}
            AND id = ${payload.integrationId}
        `;
        if (payload.migrationRunId) {
          await tx`
            UPDATE retention_migration_runs
            SET
              status = CASE
                WHEN ${lifecycleCompleted} THEN 'completed'
                ELSE 'running'
              END,
              checkpoint = ${tx.json(
                JSON.parse(canonicalJson(lifecycleState)),
              )},
              imported_count = imported_count + ${appendedCount},
              rejected_count = rejected_count + ${rejectedCount},
              completed_at = CASE
                WHEN ${lifecycleCompleted} THEN now()
                ELSE completed_at
              END,
              last_error_code = NULL,
              updated_at = now()
            WHERE org_id = ${organizationId}
              AND id = ${payload.migrationRunId}
              AND integration_id = ${payload.integrationId}
          `;
        }
        await this.auditSystem(tx, organizationId, {
          action: "integration.sync_page_completed",
          resourceType: "integration",
          resourceId: payload.integrationId,
          metadata: {
            lifecycle: payload.lifecycle,
            resource: payload.resource,
            appendedCount,
            duplicateCount,
            rejectedCount,
            pageCompleted: !page.hasMore,
            lifecycleCompleted,
          },
        });
      });
      return {
        integrationId: payload.integrationId,
        lifecycle: payload.lifecycle,
        resource: payload.resource,
        appendedCount,
        duplicateCount,
        completed: !page.hasMore,
      };
    } catch (error) {
      if (error instanceof ProviderSyncError) {
        throw new RetentionServiceError(
          error.code,
          error.message,
          error.status,
          Object.keys(error.rateLimit).length > 0
            ? { rateLimit: error.rateLimit }
            : undefined,
        );
      }
      throw error;
    }
  }

  async recordProviderSyncFailure(
    organizationId: string,
    payload: ProviderSyncJobPayload,
    error: { code: string; message: string },
  ): Promise<void> {
    await this.database.withTenant(organizationId, async (tx) => {
      await tx`
        UPDATE retention_integrations
        SET
          status = CASE
            WHEN status = 'backfilling' THEN 'failed'
            WHEN status <> 'revoked' THEN 'degraded'
            ELSE status
          END,
          last_error_code = ${error.code.slice(0, 128)},
          last_error_message = ${error.message.slice(0, 500)},
          updated_at = now()
        WHERE org_id = ${organizationId}
          AND id = ${payload.integrationId}
      `;
      if (payload.migrationRunId) {
        await tx`
          UPDATE retention_migration_runs
          SET
            status = 'failed',
            last_error_code = ${error.code.slice(0, 128)},
            updated_at = now()
          WHERE org_id = ${organizationId}
            AND id = ${payload.migrationRunId}
            AND integration_id = ${payload.integrationId}
        `;
      }
      await this.auditSystem(tx, organizationId, {
        action: "integration.sync_failed",
        resourceType: "integration",
        resourceId: payload.integrationId,
        metadata: {
          lifecycle: payload.lifecycle,
          resource: payload.resource,
          errorCode: error.code.slice(0, 128),
        },
      });
    });
  }

  async integrationWebhookSecret(input: {
    organizationId: string;
    integrationId: string;
    provider: "shopify" | "klaviyo";
  }): Promise<{ secret: string; brandId: string }> {
    assertUuid(input.organizationId, "organizationId");
    assertUuid(input.integrationId, "integrationId");
    return this.database.withTenant(input.organizationId, async (tx) => {
      const rows = await tx<
        Array<{
          webhook_secret_ciphertext: string | null;
          brand_id: string;
        }>
      >`
        SELECT webhook_secret_ciphertext, brand_id
        FROM retention_integrations
        WHERE org_id = ${input.organizationId}
          AND id = ${input.integrationId}
          AND provider = ${input.provider}
          AND status <> 'revoked'
      `;
      const row = rows[0];
      if (!row?.webhook_secret_ciphertext) {
        throw new RetentionServiceError(
          "integration_not_found",
          "The retention integration is unavailable.",
          404,
        );
      }
      return {
        secret: this.crypto.decrypt(
          row.webhook_secret_ciphertext,
          `${input.organizationId}:integration:${input.integrationId}:webhook-secret`,
        ),
        brandId: row.brand_id,
      };
    });
  }

  async integrationForWebhook(input: {
    organizationId: string;
    controlPlaneConnectionId: string;
    provider: "shopify" | "klaviyo";
  }): Promise<{ id: string; secret: string; brandId: string }> {
    assertUuid(input.organizationId, "organizationId");
    return this.database.withTenant(input.organizationId, async (tx) => {
      const rows = await tx<
        Array<{
          id: string;
          webhook_secret_ciphertext: string | null;
          brand_id: string;
        }>
      >`
        SELECT id, webhook_secret_ciphertext, brand_id
        FROM retention_integrations
        WHERE org_id = ${input.organizationId}
          AND control_plane_connection_id = ${input.controlPlaneConnectionId}
          AND provider = ${input.provider}
          AND status <> 'revoked'
      `;
      const row = rows[0];
      if (!row?.webhook_secret_ciphertext) {
        throw new RetentionServiceError(
          "integration_not_found",
          "The retention integration is unavailable.",
          404,
        );
      }
      return {
        id: row.id,
        secret: this.crypto.decrypt(
          row.webhook_secret_ciphertext,
          `${input.organizationId}:integration:${row.id}:webhook-secret`,
        ),
        brandId: row.brand_id,
      };
    });
  }

  async appendSourceEvent(
    organizationId: string,
    input: SourceEventInput,
  ): Promise<SourceEventResult> {
    const ingestionChannel = input.ingestionChannel ?? "webhook";
    if (ingestionChannel === "webhook" && !input.signatureVerified) {
      throw new RetentionServiceError(
        "webhook_signature_invalid",
        "The provider webhook signature could not be verified.",
        401,
      );
    }
    assertUuid(input.integrationId, "integrationId");
    const occurredAt = new Date(input.occurredAt);
    if (!Number.isFinite(occurredAt.getTime())) {
      throw new RetentionServiceError(
        "invalid_event_time",
        "Source event time is invalid.",
        400,
      );
    }
    const payloadJson = canonicalJson(input.payload);
    const payloadSha256 = sha256(payloadJson);
    const eventId = stableUuid(
      [
        organizationId,
        input.integrationId,
        input.provider,
        input.externalEventId,
        payloadSha256,
      ].join(":"),
    );
    const jobId = randomUUID();
    return this.database.withTenant(organizationId, async (tx) => {
      const integration = await tx<
        Array<{ brand_id: string; provider: string }>
      >`
        SELECT brand_id, provider
        FROM retention_integrations
        WHERE org_id = ${organizationId}
          AND id = ${input.integrationId}
          AND status <> 'revoked'
      `;
      if (!integration[0] || integration[0].provider !== input.provider) {
        throw new RetentionServiceError(
          "integration_not_found",
          "The retention integration is unavailable.",
          404,
        );
      }
      const inserted = await tx<Array<{ event_id: string }>>`
        INSERT INTO retention_source_event_dedup (
          org_id,
          integration_id,
          external_event_id,
          payload_sha256,
          event_id,
          occurred_at
        )
        VALUES (
          ${organizationId},
          ${input.integrationId},
          ${input.externalEventId},
          ${payloadSha256},
          ${eventId},
          ${occurredAt}
        )
        ON CONFLICT (
          org_id,
          integration_id,
          external_event_id,
          payload_sha256
        )
        DO NOTHING
        RETURNING event_id
      `;
      if (inserted.length === 0) {
        const existing = await tx<Array<{ event_id: string }>>`
          SELECT event_id
          FROM retention_source_event_dedup
          WHERE org_id = ${organizationId}
            AND integration_id = ${input.integrationId}
            AND external_event_id = ${input.externalEventId}
            AND payload_sha256 = ${payloadSha256}
        `;
        return {
          id: existing[0]!.event_id,
          duplicate: true,
          jobId: null,
        };
      }

      const payloadInserted = await tx<Array<{ event_id: string }>>`
        INSERT INTO retention_source_payload_dedup (
          org_id,
          integration_id,
          payload_sha256,
          event_id,
          occurred_at
        )
        VALUES (
          ${organizationId},
          ${input.integrationId},
          ${payloadSha256},
          ${eventId},
          ${occurredAt}
        )
        ON CONFLICT (org_id, integration_id, payload_sha256)
        DO NOTHING
        RETURNING event_id
      `;
      if (payloadInserted.length === 0) {
        const existing = await tx<Array<{ event_id: string }>>`
          SELECT event_id
          FROM retention_source_payload_dedup
          WHERE org_id = ${organizationId}
            AND integration_id = ${input.integrationId}
            AND payload_sha256 = ${payloadSha256}
        `;
        await tx`
          UPDATE retention_source_event_dedup
          SET event_id = ${existing[0]!.event_id}
          WHERE org_id = ${organizationId}
            AND integration_id = ${input.integrationId}
            AND external_event_id = ${input.externalEventId}
            AND payload_sha256 = ${payloadSha256}
        `;
        return {
          id: existing[0]!.event_id,
          duplicate: true,
          jobId: null,
        };
      }

      const encryptedPayload = this.crypto.encrypt(
        payloadJson,
        `${organizationId}:source-event:${eventId}:payload`,
      );
      const rawPayloadRef = rawPayloadReference({
        organizationId,
        integrationId: input.integrationId,
        eventId,
        occurredAt,
      });
      await tx`
        INSERT INTO retention_source_events (
          id,
          org_id,
          brand_id,
          integration_id,
          provider,
          external_event_id,
          event_type,
          customer_external_id_ciphertext,
          raw_payload_ref,
          payload_ciphertext,
          payload_sha256,
          signature_verified,
          occurred_at
        )
        VALUES (
          ${eventId},
          ${organizationId},
          ${integration[0].brand_id},
          ${input.integrationId},
          ${input.provider},
          ${input.externalEventId},
          ${input.eventType},
          ${
            input.customerExternalId
              ? this.crypto.encrypt(
                  input.customerExternalId,
                  `${organizationId}:source-event:${eventId}:customer`,
                )
              : null
          },
          ${rawPayloadRef},
          ${encryptedPayload},
          ${payloadSha256},
          ${input.signatureVerified},
          ${occurredAt}
        )
      `;
      await this.enqueueJob(tx, organizationId, {
        id: jobId,
        type: "persist_raw_payload",
        dedupeKey: eventId,
        payload: { eventId, occurredAt: occurredAt.toISOString() },
      });
      await tx`
        UPDATE retention_integrations
        SET
          last_webhook_at = CASE
            WHEN ${ingestionChannel} = 'webhook' THEN now()
            ELSE last_webhook_at
          END,
          updated_at = now(),
          status = CASE WHEN status = 'pending' THEN 'active' ELSE status END
        WHERE org_id = ${organizationId}
          AND id = ${input.integrationId}
      `;
      return { id: eventId, duplicate: false, jobId };
    });
  }

  async processSourceEvent(
    organizationId: string,
    eventId: string,
  ): Promise<{
    eventId: string;
    customerId: string | null;
    status: "processed" | "ignored";
    reasonJobs: number;
  }> {
    assertUuid(organizationId, "organizationId");
    assertUuid(eventId, "eventId");
    return this.database.withTenant(organizationId, async (tx) => {
      const events = await tx<
        Array<{
          id: string;
          brand_id: string;
          integration_id: string;
          provider: "shopify" | "klaviyo";
          external_event_id: string;
          event_type: string;
          payload_ciphertext: string;
          raw_payload_ref: string;
          processing_status: string;
          occurred_at: Date;
          property_access_mode: KlaviyoPropertyAccessMode;
          property_allowlist: unknown;
        }>
      >`
        SELECT
          event.id,
          event.brand_id,
          event.integration_id,
          event.provider,
              event.external_event_id,
              event.event_type,
              event.payload_ciphertext,
              event.raw_payload_ref,
              event.processing_status,
              event.occurred_at,
              integration.property_access_mode,
              integration.property_allowlist
        FROM retention_source_events AS event
        JOIN retention_integrations AS integration
          ON integration.org_id = event.org_id
          AND integration.id = event.integration_id
        WHERE event.org_id = ${organizationId}
          AND event.id = ${eventId}
        FOR UPDATE OF event
      `;
      const event = events[0];
      if (!event) {
        throw new RetentionServiceError(
          "source_event_not_found",
          "The source event was not found.",
          404,
        );
      }
      if (
        event.processing_status === "processed" ||
        event.processing_status === "ignored"
      ) {
        const linked = await tx<Array<{ customer_id: string | null }>>`
          SELECT customer_id
          FROM retention_source_events
          WHERE org_id = ${organizationId}
            AND id = ${eventId}
        `;
        return {
          eventId,
          customerId: linked[0]?.customer_id ?? null,
          status: event.processing_status,
          reasonJobs: 0,
        };
      }

      await tx`
        UPDATE retention_source_events
        SET processing_status = 'processing'
        WHERE org_id = ${organizationId}
          AND id = ${eventId}
      `;

      let payload: NormalizedSourcePayload;
      try {
        payload = parseNormalizedSourcePayload(
          JSON.parse(
            this.crypto.decrypt(
              event.payload_ciphertext,
              `${organizationId}:source-event:${eventId}:payload`,
            ),
          ),
        );
      } catch {
        await tx`
          UPDATE retention_source_events
          SET processing_status = 'failed'
          WHERE org_id = ${organizationId}
            AND id = ${eventId}
        `;
        throw new RetentionServiceError(
          "source_event_normalization_invalid",
          "The normalized source event is invalid.",
          422,
        );
      }

      if (isShopifyIntegrationUninstall(event.provider, event.event_type)) {
        await this.revokeIntegrationFromSource(
          tx,
          organizationId,
          event.integration_id,
          event.id,
        );
        await this.scrubSourceEvent(
          tx,
          organizationId,
          event.id,
          event.raw_payload_ref,
          null,
          "processed",
        );
        return {
          eventId,
          customerId: null,
          status: "processed",
          reasonJobs: 0,
        };
      }

      if (isShopifyShopRedaction(event.provider, event.event_type)) {
        await this.eraseBrand(
          tx,
          organizationId,
          event.brand_id,
          event.integration_id,
          event.id,
        );
        return {
          eventId,
          customerId: null,
          status: "processed",
          reasonJobs: 0,
        };
      }

      const signal = payload.customer;
      if (!signal?.externalId && !signal?.email && !signal?.phone) {
        await this.recordDeliveryEvent(
          tx,
          organizationId,
          event,
          null,
          payload,
        );
        await tx`
          UPDATE retention_source_events
          SET processing_status = 'ignored', processed_at = now()
          WHERE org_id = ${organizationId}
            AND id = ${eventId}
        `;
        return {
          eventId,
          customerId: null,
          status: "ignored",
          reasonJobs: 0,
        };
      }

      const externalIndex = signal.externalId
        ? this.crypto.blindIndex(
            signal.externalId,
            `${organizationId}:${event.brand_id}:${event.provider}:external`,
          )
        : null;
      const emailIndex = signal.email
        ? this.crypto.blindIndex(
            normalizeEmail(signal.email),
            `${organizationId}:${event.brand_id}:email`,
          )
        : null;
      const phoneIndex = signal.phone
        ? this.crypto.blindIndex(
            normalizePhone(signal.phone),
            `${organizationId}:${event.brand_id}:phone`,
          )
        : null;

      const erasedCustomers = await tx<Array<{ customer_id: string }>>`
        SELECT customer_id
        FROM retention_customer_erasure_tombstones
        WHERE org_id = ${organizationId}
          AND brand_id = ${event.brand_id}
          AND (
            (
              ${emailIndex}::TEXT IS NOT NULL
              AND primary_email_blind_index = ${emailIndex}
            )
            OR
            (
              ${phoneIndex}::TEXT IS NOT NULL
              AND primary_phone_blind_index = ${phoneIndex}
            )
          )
        UNION
        SELECT customer_id
        FROM retention_identity_erasure_tombstones
        WHERE org_id = ${organizationId}
          AND brand_id = ${event.brand_id}
          AND provider = ${event.provider}
          AND identity_type = 'provider_profile'
          AND ${externalIndex}::TEXT IS NOT NULL
          AND external_id_blind_index = ${externalIndex}
        LIMIT 1
      `;
      if (erasedCustomers[0]) {
        await this.scrubSourceEvent(
          tx,
          organizationId,
          event.id,
          event.raw_payload_ref,
          erasedCustomers[0].customer_id,
          "ignored",
        );
        await this.auditSystem(tx, organizationId, {
          action: "customer.reingestion_blocked",
          resourceType: "customer",
          resourceId: erasedCustomers[0].customer_id,
          metadata: { sourceEventId: event.id },
        });
        return {
          eventId,
          customerId: erasedCustomers[0].customer_id,
          status: "ignored",
          reasonJobs: 0,
        };
      }

      const identityCustomers = externalIndex
        ? await tx<Array<{ customer_id: string }>>`
            SELECT customer_id
            FROM retention_customer_identities
            WHERE org_id = ${organizationId}
              AND brand_id = ${event.brand_id}
              AND provider = ${event.provider}
              AND identity_type = 'provider_profile'
              AND external_id_blind_index = ${externalIndex}
              AND status = 'verified'
          `
        : [];
      const contactCustomers = await tx<Array<{ id: string }>>`
        SELECT id
        FROM retention_customers
        WHERE org_id = ${organizationId}
          AND brand_id = ${event.brand_id}
          AND status = 'active'
          AND (
            (${emailIndex}::TEXT IS NOT NULL AND primary_email_blind_index = ${emailIndex})
            OR
            (${phoneIndex}::TEXT IS NOT NULL AND primary_phone_blind_index = ${phoneIndex})
          )
      `;
      const candidateIds = new Set([
        ...identityCustomers.map((row) => row.customer_id),
        ...contactCustomers.map((row) => row.id),
      ]);
      if (candidateIds.size > 1) {
        const conflictId = randomUUID();
        await tx`
          INSERT INTO retention_identity_conflicts (
            id,
            org_id,
            brand_id,
            integration_id,
            event_id,
            conflict_type,
            candidate_customer_ids,
            evidence_ciphertext
          )
          VALUES (
            ${conflictId},
            ${organizationId},
            ${event.brand_id},
            ${event.integration_id},
            ${eventId},
            'exact_identifiers_disagree',
            ${tx.array([...candidateIds])}::UUID[],
            ${this.crypto.encrypt(
              canonicalJson({
                provider: event.provider,
                externalEventId: event.external_event_id,
                identifiers: {
                  external: Boolean(externalIndex),
                  email: Boolean(emailIndex),
                  phone: Boolean(phoneIndex),
                },
              }),
              `${organizationId}:identity-conflict:${conflictId}:evidence`,
            )}
          )
          ON CONFLICT (org_id, event_id) DO NOTHING
        `;
        await tx`
          UPDATE retention_source_events
          SET processing_status = 'ignored', processed_at = now()
          WHERE org_id = ${organizationId}
            AND id = ${eventId}
        `;
        return {
          eventId,
          customerId: null,
          status: "ignored",
          reasonJobs: 0,
        };
      }

      const customerId = [...candidateIds][0] ?? randomUUID();
      const customerExists = candidateIds.size === 1;
      if (!customerExists) {
        await tx`
          INSERT INTO retention_customers (
            id,
            org_id,
            brand_id,
            primary_email_ciphertext,
            primary_email_blind_index,
            primary_phone_ciphertext,
            primary_phone_blind_index,
            display_name_ciphertext,
            source_updated_at
          )
          VALUES (
            ${customerId},
            ${organizationId},
            ${event.brand_id},
            ${
              signal.email
                ? this.crypto.encrypt(
                    normalizeEmail(signal.email),
                    `${organizationId}:customer:${customerId}:email`,
                  )
                : null
            },
            ${emailIndex},
            ${
              signal.phone
                ? this.crypto.encrypt(
                    normalizePhone(signal.phone),
                    `${organizationId}:customer:${customerId}:phone`,
                  )
                : null
            },
            ${phoneIndex},
            ${
              signal.displayName
                ? this.crypto.encrypt(
                    signal.displayName,
                    `${organizationId}:customer:${customerId}:name`,
                  )
                : null
            },
            ${event.occurred_at}
          )
        `;
      } else {
        await tx`
          UPDATE retention_customers
          SET
            primary_email_ciphertext = COALESCE(
              ${
                signal.email
                  ? this.crypto.encrypt(
                      normalizeEmail(signal.email),
                      `${organizationId}:customer:${customerId}:email`,
                    )
                  : null
              },
              primary_email_ciphertext
            ),
            primary_email_blind_index = COALESCE(
              ${emailIndex},
              primary_email_blind_index
            ),
            primary_phone_ciphertext = COALESCE(
              ${
                signal.phone
                  ? this.crypto.encrypt(
                      normalizePhone(signal.phone),
                      `${organizationId}:customer:${customerId}:phone`,
                    )
                  : null
              },
              primary_phone_ciphertext
            ),
            primary_phone_blind_index = COALESCE(
              ${phoneIndex},
              primary_phone_blind_index
            ),
            display_name_ciphertext = COALESCE(
              ${
                signal.displayName
                  ? this.crypto.encrypt(
                      signal.displayName,
                      `${organizationId}:customer:${customerId}:name`,
                    )
                  : null
              },
              display_name_ciphertext
            ),
            source_updated_at = ${event.occurred_at},
            updated_at = now()
          WHERE org_id = ${organizationId}
            AND id = ${customerId}
            AND (
              source_updated_at IS NULL
              OR source_updated_at <= ${event.occurred_at}
            )
        `;
      }

      if (signal.externalId && externalIndex) {
        const identityId = randomUUID();
        await tx`
          INSERT INTO retention_customer_identities (
            id,
            org_id,
            brand_id,
            customer_id,
            provider,
            identity_type,
            external_id_ciphertext,
            external_id_blind_index,
            status,
            first_seen_at,
            last_seen_at
          )
          VALUES (
            ${identityId},
            ${organizationId},
            ${event.brand_id},
            ${customerId},
            ${event.provider},
            'provider_profile',
            ${this.crypto.encrypt(
              signal.externalId,
              `${organizationId}:identity:${identityId}:external`,
            )},
            ${externalIndex},
            'verified',
            ${event.occurred_at},
            ${event.occurred_at}
          )
          ON CONFLICT (
            org_id,
            brand_id,
            provider,
            identity_type,
            external_id_blind_index
          )
          DO UPDATE SET
            last_seen_at = GREATEST(
              retention_customer_identities.last_seen_at,
              excluded.last_seen_at
            ),
            updated_at = now()
        `;
      }

      if (isCustomerPrivacyDeletion(event.provider, event.event_type)) {
        await this.eraseCustomer(tx, organizationId, customerId, eventId);
        await this.auditSystem(tx, organizationId, {
          action: "customer.privacy_erased",
          resourceType: "customer",
          resourceId: customerId,
          metadata: { sourceEventId: eventId },
        });
        return {
          eventId,
          customerId,
          status: "processed",
          reasonJobs: 0,
        };
      }

      if (payload.consent) {
        await tx`
          INSERT INTO retention_consent_events (
            id,
            org_id,
            brand_id,
            customer_id,
            channel,
            state,
            source_provider,
            source_event_id,
            occurred_at
          )
          VALUES (
            ${randomUUID()},
            ${organizationId},
            ${event.brand_id},
            ${customerId},
            ${payload.consent.channel},
            ${payload.consent.state},
            ${event.provider},
            ${eventId},
            ${event.occurred_at}
          )
        `;
      }

      const allowlist = Array.isArray(event.property_allowlist)
        ? event.property_allowlist.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      for (const trait of payload.traits ?? []) {
        if (
          event.provider === "klaviyo" &&
          !isApprovedKlaviyoTraitKey(
            trait.key,
            event.property_access_mode,
            allowlist,
          )
        ) {
          continue;
        }
        const traitId = randomUUID();
        await tx`
          INSERT INTO retention_customer_traits (
            id,
            org_id,
            brand_id,
            customer_id,
            trait_key,
            value_ciphertext,
            value_type,
            evidence_kind,
            sensitivity,
            confidence,
            evidence_event_ids,
            observed_at,
            expires_at
          )
          VALUES (
            ${traitId},
            ${organizationId},
            ${event.brand_id},
            ${customerId},
            ${trait.key},
            ${this.crypto.encrypt(
              canonicalJson(trait.value),
              `${organizationId}:trait:${traitId}:value`,
            )},
            ${Array.isArray(trait.value) ? "array" : typeof trait.value},
            ${trait.evidenceKind},
            ${trait.sensitivity},
            ${trait.confidence},
            ${tx.array([eventId])}::UUID[],
            ${event.occurred_at},
            ${trait.expiresAt ? new Date(trait.expiresAt) : null}
          )
        `;
      }

      await this.recordDeliveryEvent(
        tx,
        organizationId,
        event,
        customerId,
        payload,
      );
      await tx`
        UPDATE retention_feature_snapshots
        SET invalidated_at = now()
        WHERE org_id = ${organizationId}
          AND customer_id = ${customerId}
          AND invalidated_at IS NULL
      `;
      await tx`
        UPDATE retention_customer_decisions
        SET
          status = 'expired',
          invalidated_at = now(),
          updated_at = now()
        WHERE org_id = ${organizationId}
          AND customer_id = ${customerId}
          AND invalidated_at IS NULL
      `;

      const programs = await tx<Array<{ id: string }>>`
        SELECT id
        FROM retention_programs
        WHERE org_id = ${organizationId}
          AND brand_id = ${event.brand_id}
          AND status = 'active'
      `;
      for (const program of programs) {
        const decisionId = randomUUID();
        await tx`
          INSERT INTO retention_customer_decisions (
            id,
            org_id,
            brand_id,
            customer_id,
            program_id,
            status,
            input_evidence_cutoff_at
          )
          VALUES (
            ${decisionId},
            ${organizationId},
            ${event.brand_id},
            ${customerId},
            ${program.id},
            'pending_reasoning',
            ${event.occurred_at}
          )
        `;
        await this.enqueueJob(tx, organizationId, {
          id: randomUUID(),
          type: "reason_customer",
          dedupeKey: `${program.id}:${customerId}:${eventId}`,
          payload: {
            decisionId,
            customerId,
            programId: program.id,
            evidenceCutoffAt: event.occurred_at.toISOString(),
          },
        });
      }
      await tx`
        UPDATE retention_source_events
        SET
          customer_id = ${customerId},
          processing_status = 'processed',
          processed_at = now()
        WHERE org_id = ${organizationId}
          AND id = ${eventId}
      `;
      return {
        eventId,
        customerId,
        status: "processed",
        reasonJobs: programs.length,
      };
    });
  }

  async processRawPayloadPersistence(
    organizationId: string,
    eventId: string,
  ): Promise<{ eventId: string; duplicate: boolean }> {
    assertUuid(organizationId, "organizationId");
    assertUuid(eventId, "eventId");
    return this.database.withTenant(organizationId, async (tx) => {
      const rows = await tx<
        Array<{
          integration_id: string;
          raw_payload_ref: string;
          payload_ciphertext: string;
          occurred_at: Date;
        }>
      >`
        SELECT
          integration_id,
          raw_payload_ref,
          payload_ciphertext,
          occurred_at
        FROM retention_source_events
        WHERE org_id = ${organizationId}
          AND id = ${eventId}
        FOR UPDATE
      `;
      const sourceEvent = rows[0];
      if (!sourceEvent) {
        throw new RetentionServiceError(
          "source_event_not_found",
          "The source event was not found.",
          404,
        );
      }
      if (!sourceEvent.raw_payload_ref.startsWith("source-events/")) {
        return { eventId, duplicate: true };
      }
      const writtenReference =
        await this.options.rawPayloadStore.putEncryptedPayload({
          organizationId,
          integrationId: sourceEvent.integration_id,
          eventId,
          occurredAt: sourceEvent.occurred_at,
          encryptedPayload: sourceEvent.payload_ciphertext,
        });
      if (writtenReference !== sourceEvent.raw_payload_ref) {
        throw new RetentionServiceError(
          "raw_payload_reference_mismatch",
          "Raw-payload storage returned an unexpected reference.",
          500,
        );
      }
      await this.enqueueJob(tx, organizationId, {
        id: randomUUID(),
        type: "normalize_source_event",
        dedupeKey: eventId,
        payload: {
          eventId,
          occurredAt: sourceEvent.occurred_at.toISOString(),
        },
      });
      await this.auditSystem(tx, organizationId, {
        action: "raw_payload.persisted",
        resourceType: "source_event",
        resourceId: eventId,
      });
      return { eventId, duplicate: false };
    });
  }

  async processRawPayloadDeletion(
    organizationId: string,
    deletionId: string,
  ): Promise<{ deletionId: string; duplicate: boolean }> {
    assertUuid(organizationId, "organizationId");
    assertUuid(deletionId, "deletionId");
    const deletion = await this.database.withTenant(
      organizationId,
      async (tx) => {
        const rows = await tx<
          Array<{
            raw_payload_ref: string;
            status: "pending" | "deleted";
          }>
        >`
          SELECT raw_payload_ref, status
          FROM retention_raw_payload_deletions
          WHERE org_id = ${organizationId}
            AND id = ${deletionId}
        `;
        return rows[0] ?? null;
      },
    );
    if (!deletion) {
      throw new RetentionServiceError(
        "raw_payload_deletion_not_found",
        "The raw-payload deletion request was not found.",
        404,
      );
    }
    if (deletion.status === "deleted") {
      return { deletionId, duplicate: true };
    }
    try {
      await this.options.rawPayloadStore.deleteEncryptedPayload(
        deletion.raw_payload_ref,
      );
    } catch (error) {
      await this.database.withTenant(organizationId, async (tx) => {
        await tx`
          UPDATE retention_raw_payload_deletions
          SET
            attempt_count = attempt_count + 1,
            last_error_code = 'raw_payload_delete_failed',
            updated_at = now()
          WHERE org_id = ${organizationId}
            AND id = ${deletionId}
            AND status = 'pending'
        `;
      });
      throw error;
    }
    await this.database.withTenant(organizationId, async (tx) => {
      await tx`
        UPDATE retention_raw_payload_deletions
        SET
          status = 'deleted',
          attempt_count = attempt_count + 1,
          last_error_code = NULL,
          deleted_at = now(),
          updated_at = now()
        WHERE org_id = ${organizationId}
          AND id = ${deletionId}
          AND status = 'pending'
      `;
      await this.auditSystem(tx, organizationId, {
        action: "raw_payload.deleted",
        resourceType: "raw_payload_deletion",
        resourceId: deletionId,
      });
    });
    return { deletionId, duplicate: false };
  }

  async createProgram(
    context: TenantContext,
    input: {
      brandId: string;
      type: RetentionProgram;
      name: string;
      policyVersion: string;
      policy: unknown;
    },
  ): Promise<{ id: string; status: "draft" }> {
    assertUuid(input.brandId, "brandId");
    const id = randomUUID();
    await this.database.withTenant(context.organizationId, async (tx) => {
      await tx`
        INSERT INTO retention_programs (
          id,
          org_id,
          brand_id,
          program_type,
          name,
          status,
          policy_version,
          policy
        )
        VALUES (
          ${id},
          ${context.organizationId},
          ${input.brandId},
          ${input.type},
          ${input.name.trim()},
          'draft',
          ${input.policyVersion},
          ${tx.json(JSON.parse(canonicalJson(input.policy)))}
        )
      `;
      await this.audit(tx, context, {
        action: "program.created",
        resourceType: "program",
        resourceId: id,
        metadata: { programType: input.type },
      });
    });
    return { id, status: "draft" };
  }

  async listPrograms(
    context: TenantContext,
    input: { brandId: string },
  ): Promise<{
    programs: Array<{
      id: string;
      brandId: string;
      type: RetentionProgram;
      name: string;
      status: "draft" | "active" | "paused" | "archived";
      policyVersion: string;
      policyApprovalSha256: string | null;
      approvedBy: string | null;
      approvedAt: string | null;
      updatedAt: string;
    }>;
  }> {
    assertUuid(input.brandId, "brandId");
    return this.database.withTenant(context.organizationId, async (tx) => {
      const rows = await tx<
        Array<{
          id: string;
          brand_id: string;
          program_type: RetentionProgram;
          name: string;
          status: "draft" | "active" | "paused" | "archived";
          policy_version: string;
          policy_approval_sha256: string | null;
          approved_by: string | null;
          approved_at: Date | null;
          updated_at: Date;
        }>
      >`
        SELECT
          id,
          brand_id,
          program_type,
          name,
          status,
          policy_version,
          policy_approval_sha256,
          approved_by,
          approved_at,
          updated_at
        FROM retention_programs
        WHERE org_id = ${context.organizationId}
          AND brand_id = ${input.brandId}
        ORDER BY updated_at DESC, id
        LIMIT 100
      `;
      return {
        programs: rows.map((row) => ({
          id: row.id,
          brandId: row.brand_id,
          type: row.program_type,
          name: row.name,
          status: row.status,
          policyVersion: row.policy_version,
          policyApprovalSha256: row.policy_approval_sha256,
          approvedBy: row.approved_by,
          approvedAt: row.approved_at?.toISOString() ?? null,
          updatedAt: row.updated_at.toISOString(),
        })),
      };
    });
  }

  async programPolicyApprovalPreview(
    context: TenantContext,
    programId: string,
    brandId: string,
  ): Promise<{
    programId: string;
    status: "draft" | "active" | "paused" | "archived";
    snapshotSha256: string;
    material: ProgramPolicyApprovalMaterial;
  }> {
    assertUuid(programId, "programId");
    return this.database.withTenant(context.organizationId, async (tx) => {
      const rows = await tx<
        Array<{
          program_type: RetentionProgram;
          name: string;
          status: "draft" | "active" | "paused" | "archived";
          policy_version: string;
          policy: RetentionJsonValue;
        }>
      >`
        SELECT program_type, name, status, policy_version, policy
        FROM retention_programs
        WHERE org_id = ${context.organizationId}
          AND id = ${programId}
          AND brand_id = ${brandId}
      `;
      const row = rows[0];
      if (!row) {
        throw new RetentionServiceError(
          "program_not_found",
          "The retention program was not found.",
          404,
        );
      }
      const material: ProgramPolicyApprovalMaterial = {
        orgId: context.organizationId,
        programId,
        program: row.program_type,
        name: row.name,
        policyVersion: row.policy_version,
        policy: row.policy,
      };
      const checksum = getProgramPolicyApprovalChecksum(material);
      if (!checksum.ok) {
        throw new RetentionServiceError(
          checksum.error.code,
          checksum.error.message,
          409,
          checksum.error.details ? { ...checksum.error.details } : undefined,
        );
      }
      return {
        programId,
        status: row.status,
        snapshotSha256: checksum.value,
        material,
      };
    });
  }

  async activateProgram(
    context: TenantContext,
    input: {
      programId: string;
      brandId: string;
      expectedPolicySha256: string;
      note?: string;
    },
  ): Promise<{
    programId: string;
    status: "active";
    snapshotSha256: string;
    duplicate: boolean;
  }> {
    assertUuid(input.programId, "programId");
    assertSha256(input.expectedPolicySha256, "expectedPolicySha256");
    if (
      !context.permissions.includes("retention:approve") &&
      !context.permissions.includes("retention:*")
    ) {
      throw new RetentionServiceError(
        "program_approval_permission_required",
        "A named retention program approver is required.",
        403,
      );
    }
    return this.database.withTenant(context.organizationId, async (tx) => {
      const rows = await tx<
        Array<{
          program_type: RetentionProgram;
          name: string;
          status: "draft" | "active" | "paused" | "archived";
          policy_version: string;
          policy: RetentionJsonValue;
          policy_approval_sha256: string | null;
        }>
      >`
        SELECT
          program_type,
          name,
          status,
          policy_version,
          policy,
          policy_approval_sha256
        FROM retention_programs
        WHERE org_id = ${context.organizationId}
          AND id = ${input.programId}
          AND brand_id = ${input.brandId}
        FOR UPDATE
      `;
      const row = rows[0];
      if (!row) {
        throw new RetentionServiceError(
          "program_not_found",
          "The retention program was not found.",
          404,
        );
      }
      if (row.status === "archived") {
        throw new RetentionServiceError(
          "program_not_activatable",
          "An archived retention program cannot be activated.",
          409,
        );
      }
      const material: ProgramPolicyApprovalMaterial = {
        orgId: context.organizationId,
        programId: input.programId,
        program: row.program_type,
        name: row.name,
        policyVersion: row.policy_version,
        policy: row.policy,
      };
      const checksum = getProgramPolicyApprovalChecksum(material);
      if (!checksum.ok) {
        throw new RetentionServiceError(
          checksum.error.code,
          checksum.error.message,
          409,
        );
      }
      if (checksum.value !== input.expectedPolicySha256) {
        throw new RetentionServiceError(
          "program_approval_invalidated",
          "The retention program policy changed before activation.",
          409,
        );
      }
      if (
        row.status === "active" &&
        row.policy_approval_sha256 === checksum.value
      ) {
        return {
          programId: input.programId,
          status: "active",
          snapshotSha256: checksum.value,
          duplicate: true,
        };
      }
      await tx`
        UPDATE retention_programs
        SET
          status = 'active',
          policy_approval_sha256 = ${checksum.value},
          policy_material_ciphertext = ${this.crypto.encrypt(
            canonicalJson({
              material,
              note: input.note?.trim() ?? null,
            }),
            `${context.organizationId}:program:${input.programId}:approval`,
          )},
          approved_by = ${context.userId},
          approved_at = now(),
          updated_at = now()
        WHERE org_id = ${context.organizationId}
          AND id = ${input.programId}
          AND brand_id = ${input.brandId}
      `;
      await this.audit(tx, context, {
        action: "program.activated",
        resourceType: "program",
        resourceId: input.programId,
        metadata: { snapshotSha256: checksum.value },
      });
      return {
        programId: input.programId,
        status: "active",
        snapshotSha256: checksum.value,
        duplicate: false,
      };
    });
  }

  async pauseProgram(
    context: TenantContext,
    input: { programId: string; brandId: string; reason: string },
  ): Promise<{
    programId: string;
    status: "paused";
    duplicate: boolean;
  }> {
    assertUuid(input.programId, "programId");
    if (
      !context.permissions.includes("retention:approve") &&
      !context.permissions.includes("retention:*")
    ) {
      throw new RetentionServiceError(
        "program_approval_permission_required",
        "A named retention program approver is required.",
        403,
      );
    }
    return this.database.withTenant(context.organizationId, async (tx) => {
      const rows = await tx<Array<{ status: string }>>`
        SELECT status
        FROM retention_programs
        WHERE org_id = ${context.organizationId}
          AND id = ${input.programId}
          AND brand_id = ${input.brandId}
        FOR UPDATE
      `;
      if (!rows[0]) {
        throw new RetentionServiceError(
          "program_not_found",
          "The retention program was not found.",
          404,
        );
      }
      if (rows[0].status === "archived") {
        throw new RetentionServiceError(
          "program_not_pausable",
          "An archived retention program cannot be paused.",
          409,
        );
      }
      if (rows[0].status === "paused") {
        return {
          programId: input.programId,
          status: "paused",
          duplicate: true,
        };
      }
      await tx`
        UPDATE retention_programs
        SET status = 'paused', updated_at = now()
        WHERE org_id = ${context.organizationId}
          AND id = ${input.programId}
          AND brand_id = ${input.brandId}
      `;
      await this.audit(tx, context, {
        action: "program.paused",
        resourceType: "program",
        resourceId: input.programId,
        metadata: { reasonSha256: sha256(input.reason.trim()) },
      });
      return {
        programId: input.programId,
        status: "paused",
        duplicate: false,
      };
    });
  }

  async createSegmentDefinition(
    context: TenantContext,
    input: {
      brandId: string;
      name: string;
      version: number;
      expression: WorklinSegmentExpression;
    },
  ): Promise<{
    id: string;
    status: "draft";
    version: number;
    references: Array<{ namespace: string; key: string }>;
  }> {
    assertUuid(input.brandId, "brandId");
    const validation = validateWorklinSegmentExpression(input.expression);
    if (!validation.ok) {
      throw new RetentionServiceError(
        validation.error.code,
        validation.error.message,
        400,
        validation.error.details ? { ...validation.error.details } : undefined,
      );
    }
    const id = randomUUID();
    await this.database.withTenant(context.organizationId, async (tx) => {
      await tx`
        INSERT INTO retention_segment_definitions (
          id,
          org_id,
          brand_id,
          name,
          version,
          expression,
          status,
          created_by
        )
        VALUES (
          ${id},
          ${context.organizationId},
          ${input.brandId},
          ${input.name.trim()},
          ${input.version},
          ${tx.json(JSON.parse(canonicalJson(input.expression)))},
          'draft',
          ${context.userId}
        )
      `;
      await this.audit(tx, context, {
        action: "segment_definition.created",
        resourceType: "segment_definition",
        resourceId: id,
        metadata: {
          version: input.version,
          references: validation.value.references,
        },
      });
    });
    return {
      id,
      status: "draft",
      version: input.version,
      references: [...validation.value.references],
    };
  }

  async createSegmentRun(
    context: TenantContext,
    input: {
      brandId: string;
      maxSegments: number;
      sampleLimitPerSegment: number;
      trancheSize: number;
      cohortLimit?: number;
      evidenceCutoffAt?: string;
    },
  ): Promise<{
    id: string;
    brandName: string;
    status: string;
    maxSegments: number;
    sampleLimitPerSegment: number;
    trancheSize: number;
    cohortLimit: number;
    cohortCount: number;
    evidenceCutoffAt: string;
    duplicate: boolean;
  }> {
    assertUuid(input.brandId, "brandId");
    if (
      !Number.isInteger(input.maxSegments) ||
      input.maxSegments < 1 ||
      input.maxSegments > 50
    ) {
      throw new RetentionServiceError(
        "invalid_segment_limit",
        "A segment run must request between 1 and 50 segments.",
        400,
      );
    }
    if (
      !Number.isInteger(input.sampleLimitPerSegment) ||
      input.sampleLimitPerSegment < 1 ||
      input.sampleLimitPerSegment > 2
    ) {
      throw new RetentionServiceError(
        "invalid_sample_limit",
        "A segment run must request one or two samples per segment.",
        400,
      );
    }
    if (
      !Number.isInteger(input.trancheSize) ||
      input.trancheSize < 1 ||
      input.trancheSize > 10
    ) {
      throw new RetentionServiceError(
        "invalid_tranche_size",
        "A segment run tranche must contain between 1 and 10 segments.",
        400,
      );
    }
    const cohortLimit = input.cohortLimit ?? 500;
    if (
      !Number.isInteger(cohortLimit) ||
      cohortLimit < 1 ||
      cohortLimit > 500
    ) {
      throw new RetentionServiceError(
        "invalid_cohort_limit",
        "A campaign review cohort must contain between 1 and 500 profiles.",
        400,
      );
    }
    const evidenceCutoff = input.evidenceCutoffAt
      ? new Date(input.evidenceCutoffAt)
      : new Date();
    if (
      !Number.isFinite(evidenceCutoff.getTime()) ||
      evidenceCutoff.getTime() > Date.now() + 60_000
    ) {
      throw new RetentionServiceError(
        "invalid_evidence_cutoff",
        "The evidence cutoff must be a current or past timestamp.",
        400,
      );
    }

    return this.database.withTenant(context.organizationId, async (tx) => {
      const brands = await tx<
        Array<{ id: string; name: string; website_url: string | null }>
      >`
        SELECT id, name, website_url
        FROM retention_brands
        WHERE org_id = ${context.organizationId}
          AND id = ${input.brandId}
          AND status = 'active'
        FOR UPDATE
      `;
      const brand = brands[0];
      if (!brand) {
        throw new RetentionServiceError(
          "brand_not_found",
          "The retention brand is unavailable.",
          404,
        );
      }
      const openRuns = await tx<
        Array<{
          id: string;
          status: string;
          max_segments: number;
          sample_limit_per_segment: number;
          tranche_size: number;
          cohort_limit: number;
          cohort_count: number;
          evidence_cutoff_at: Date;
        }>
      >`
        SELECT
          id,
          status,
          max_segments,
          sample_limit_per_segment,
          tranche_size,
          cohort_limit,
          cohort_count,
          evidence_cutoff_at
        FROM retention_segment_runs
        WHERE org_id = ${context.organizationId}
          AND brand_id = ${input.brandId}
          AND status IN ('queued', 'claimed', 'paused')
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (openRuns[0]?.cohort_count && openRuns[0].cohort_count > 0) {
        return {
          id: openRuns[0].id,
          brandName: brand.name,
          status: openRuns[0].status,
          maxSegments: openRuns[0].max_segments,
          sampleLimitPerSegment: openRuns[0].sample_limit_per_segment,
          trancheSize: openRuns[0].tranche_size,
          cohortLimit: openRuns[0].cohort_limit,
          cohortCount: openRuns[0].cohort_count,
          evidenceCutoffAt: openRuns[0].evidence_cutoff_at.toISOString(),
          duplicate: true,
        };
      }
      if (openRuns[0]) {
        await tx`
          UPDATE retention_segment_runs
          SET
            status = 'failed',
            last_error_code = 'legacy_run_requires_restart',
            updated_at = now()
          WHERE org_id = ${context.organizationId}
            AND id = ${openRuns[0].id}
        `;
      }

      const cohortRows = await tx<Array<{ id: string }>>`
        SELECT
          customer.id
        FROM retention_customers AS customer
        JOIN LATERAL (
          SELECT state
          FROM retention_consent_events
          WHERE org_id = customer.org_id
            AND customer_id = customer.id
            AND channel = 'email'
            AND occurred_at <= ${evidenceCutoff}
          ORDER BY occurred_at DESC, created_at DESC
          LIMIT 1
        ) AS consent ON consent.state = 'subscribed'
        LEFT JOIN LATERAL (
          SELECT
            max(occurred_at) AS latest_at,
            count(*) AS event_count,
            max(occurred_at) FILTER (
              WHERE event_type !~* '(^|[^a-z])open(?:ed)?([^a-z]|$)'
            ) AS latest_non_open_at,
            count(*) FILTER (
              WHERE event_type !~* '(^|[^a-z])open(?:ed)?([^a-z]|$)'
            ) AS non_open_event_count
          FROM retention_source_events
          WHERE org_id = customer.org_id
            AND brand_id = customer.brand_id
            AND customer_id = customer.id
            AND occurred_at <= ${evidenceCutoff}
            AND processing_status IN ('processed', 'ignored')
        ) AS activity ON true
        WHERE customer.org_id = ${context.organizationId}
          AND customer.brand_id = ${input.brandId}
          AND customer.status = 'active'
          AND customer.primary_email_ciphertext IS NOT NULL
          AND customer.created_at <= ${evidenceCutoff}
        ORDER BY
          activity.latest_non_open_at DESC NULLS LAST,
          activity.non_open_event_count DESC,
          activity.latest_at DESC NULLS LAST,
          activity.event_count DESC,
          customer.id
        LIMIT ${cohortLimit}
      `;
      const cohortCustomerIds = cohortRows.map((row) => row.id);
      if (cohortCustomerIds.length === 0) {
        throw new RetentionServiceError(
          "live_data_required",
          "No currently subscribed profiles are available for campaign review.",
          409,
        );
      }

      const customerSummary = await tx<
        Array<{
          customer_count: string;
          email_count: string;
          subscribed_count: string;
          unsubscribed_count: string;
          suppressed_count: string;
        }>
      >`
        SELECT
          count(*)::TEXT AS customer_count,
          count(*) FILTER (
            WHERE customer.primary_email_ciphertext IS NOT NULL
          )::TEXT AS email_count,
          count(*) FILTER (WHERE consent.state = 'subscribed')::TEXT
            AS subscribed_count,
          count(*) FILTER (WHERE consent.state = 'unsubscribed')::TEXT
            AS unsubscribed_count,
          count(*) FILTER (WHERE consent.state = 'suppressed')::TEXT
            AS suppressed_count
        FROM retention_customers AS customer
        LEFT JOIN LATERAL (
          SELECT state
          FROM retention_consent_events
          WHERE org_id = customer.org_id
            AND customer_id = customer.id
            AND channel = 'email'
            AND occurred_at <= ${evidenceCutoff}
          ORDER BY occurred_at DESC, created_at DESC
          LIMIT 1
        ) AS consent ON true
        WHERE customer.org_id = ${context.organizationId}
          AND customer.brand_id = ${input.brandId}
          AND customer.id = ANY(${tx.array(cohortCustomerIds)}::UUID[])
          AND customer.status = 'active'
          AND customer.created_at <= ${evidenceCutoff}
      `;
      const eventSummary = await tx<
        Array<{
          provider: string;
          event_type: string;
          event_count: string;
          latest_at: Date;
        }>
      >`
        SELECT
          provider,
          event_type,
          count(*)::TEXT AS event_count,
          max(occurred_at) AS latest_at
        FROM retention_source_events
        WHERE org_id = ${context.organizationId}
          AND brand_id = ${input.brandId}
          AND customer_id = ANY(${tx.array(cohortCustomerIds)}::UUID[])
          AND occurred_at <= ${evidenceCutoff}
          AND processing_status IN ('processed', 'ignored')
        GROUP BY provider, event_type
        ORDER BY count(*) DESC, provider, event_type
        LIMIT 100
      `;
      const traitSummary = await tx<
        Array<{ trait_key: string; customer_count: string }>
      >`
        SELECT trait_key, count(DISTINCT customer_id)::TEXT AS customer_count
        FROM retention_customer_traits
        WHERE org_id = ${context.organizationId}
          AND brand_id = ${input.brandId}
          AND customer_id = ANY(${tx.array(cohortCustomerIds)}::UUID[])
          AND observed_at <= ${evidenceCutoff}
          AND (expires_at IS NULL OR expires_at > ${evidenceCutoff})
          AND targeting_status NOT IN ('rejected', 'expired')
          AND sensitivity IN ('standard', 'personal')
        GROUP BY trait_key
        ORDER BY count(DISTINCT customer_id) DESC, trait_key
        LIMIT 100
      `;
      const traitValueRows = await tx<
        Array<{
          id: string;
          trait_key: string;
          value_ciphertext: string;
        }>
      >`
        SELECT id, trait_key, value_ciphertext
        FROM (
          SELECT
            id,
            customer_id,
            trait_key,
            value_ciphertext,
            observed_at,
            row_number() OVER (
              PARTITION BY customer_id, trait_key
              ORDER BY observed_at DESC, id DESC
            ) AS trait_rank
          FROM retention_customer_traits
          WHERE org_id = ${context.organizationId}
            AND brand_id = ${input.brandId}
            AND customer_id = ANY(${tx.array(cohortCustomerIds)}::UUID[])
            AND observed_at <= ${evidenceCutoff}
            AND (expires_at IS NULL OR expires_at > ${evidenceCutoff})
            AND targeting_status NOT IN ('rejected', 'expired')
            AND sensitivity IN ('standard', 'personal')
        ) AS current_trait
        WHERE trait_rank = 1
        ORDER BY observed_at DESC, id
        LIMIT 5000
      `;
      const traitValueCounts = new Map<
        string,
        Map<string, { value: string | number | boolean; count: number }>
      >();
      for (const row of traitValueRows) {
        let value: unknown;
        try {
          value = JSON.parse(
            this.crypto.decrypt(
              row.value_ciphertext,
              `${context.organizationId}:trait:${row.id}:value`,
            ),
          );
        } catch {
          continue;
        }
        const scalar = scalarForDossier(value);
        if (
          scalar === null ||
          (typeof scalar === "string" &&
            (scalar.length > 100 || redactOperatorText(scalar, []) !== scalar))
        ) {
          continue;
        }
        const keyCounts = traitValueCounts.get(row.trait_key) ?? new Map();
        const valueKey = canonicalJson(scalar);
        const current = keyCounts.get(valueKey) ?? { value: scalar, count: 0 };
        current.count += 1;
        keyCounts.set(valueKey, current);
        traitValueCounts.set(row.trait_key, keyCounts);
      }
      const summary = customerSummary[0] ?? {
        customer_count: "0",
        email_count: "0",
        subscribed_count: "0",
        unsubscribed_count: "0",
        suppressed_count: "0",
      };
      const discovery = await this.buildSegmentDiscoverySummary(tx, {
        organizationId: context.organizationId,
        brandId: input.brandId,
        evidenceCutoff,
        customerIds: cohortCustomerIds,
      });
      const dossier = {
        version: "segment_account_dossier_v3",
        brand: {
          name: brand.name,
          websiteUrl: brand.website_url,
        },
        evidenceCutoffAt: evidenceCutoff.toISOString(),
        cohort: {
          strategy: "recent_non_open_activity_v1",
          requestedProfiles: cohortLimit,
          frozenProfiles: cohortCustomerIds.length,
          includesOnlyCurrentlySubscribedProfiles: true,
        },
        customers: {
          total: Number(summary.customer_count),
          withEmail: Number(summary.email_count),
          emailConsent: {
            subscribed: Number(summary.subscribed_count),
            unsubscribed: Number(summary.unsubscribed_count),
            suppressed: Number(summary.suppressed_count),
            unknown: Math.max(
              0,
              Number(summary.customer_count) -
                Number(summary.subscribed_count) -
                Number(summary.unsubscribed_count) -
                Number(summary.suppressed_count),
            ),
          },
        },
        eventSignals: eventSummary.map((row) => ({
          provider: row.provider,
          type: row.event_type,
          count: Number(row.event_count),
          latestAt: row.latest_at.toISOString(),
        })),
        profileCoverage: discovery.profileCoverage,
        behaviorCombinations: discovery.behaviorCombinations,
        availableTraits: traitSummary.map((row) => ({
          key: row.trait_key,
          customerCount: Number(row.customer_count),
          observedValues: [
            ...(traitValueCounts.get(row.trait_key)?.values() ?? []),
          ]
            .filter((value) => value.count >= 3)
            .sort(
              (left, right) =>
                right.count - left.count ||
                canonicalJson(left.value).localeCompare(
                  canonicalJson(right.value),
                ),
            )
            .slice(0, 20)
            .map((value) => ({
              value: value.value,
              sampledCount: value.count,
            })),
        })),
        expressionGrammar: {
          namespaces: {
            profile: [
              "status",
              "has_email",
              "has_phone",
              "created_at",
              "source_updated_at",
            ],
            consent: ["email"],
            metric: [
              "source_event_count",
              "klaviyo_event_count",
              "days_since_last_event",
            ],
            evidence: ["provider", "event_type"],
            trait: traitSummary.map((row) => row.trait_key),
          },
          operators: [
            "equals",
            "not_equals",
            "exists",
            "not_exists",
            "contains",
            "not_contains",
            "in",
            "not_in",
            "greater_than",
            "greater_than_or_equal",
            "less_than",
            "less_than_or_equal",
            "after",
            "before",
          ],
        },
      };
      const runId = randomUUID();
      const dossierJson = canonicalJson(dossier);
      await tx`
        INSERT INTO retention_segment_runs (
          id,
          org_id,
          brand_id,
          max_segments,
          sample_limit_per_segment,
          tranche_size,
          cohort_limit,
          cohort_count,
          cohort_strategy,
          evidence_cutoff_at,
          account_dossier_ciphertext,
          account_dossier_sha256,
          created_by
        )
        VALUES (
          ${runId},
          ${context.organizationId},
          ${input.brandId},
          ${input.maxSegments},
          ${input.sampleLimitPerSegment},
          ${input.trancheSize},
          ${cohortLimit},
          ${cohortCustomerIds.length},
          'recent_non_open_activity_v1',
          ${evidenceCutoff},
          ${this.crypto.encrypt(
            dossierJson,
            `${context.organizationId}:segment-run:${runId}:dossier`,
          )},
          ${sha256(dossierJson)},
          ${context.userId}
        )
      `;
      await tx`
        INSERT INTO retention_segment_run_cohort ${tx(
          cohortCustomerIds.map((customerId, index) => ({
            org_id: context.organizationId,
            segment_run_id: runId,
            customer_id: customerId,
            selected_rank: index + 1,
            evidence_cutoff_at: evidenceCutoff,
          })),
          "org_id",
          "segment_run_id",
          "customer_id",
          "selected_rank",
          "evidence_cutoff_at",
        )}
      `;
      await this.audit(tx, context, {
        action: "segment_run.created",
        resourceType: "segment_run",
        resourceId: runId,
        metadata: {
          maxSegments: input.maxSegments,
          sampleLimitPerSegment: input.sampleLimitPerSegment,
          trancheSize: input.trancheSize,
          cohortLimit,
          cohortCount: cohortCustomerIds.length,
          evidenceCutoffAt: evidenceCutoff.toISOString(),
        },
      });
      return {
        id: runId,
        brandName: brand.name,
        status: "queued",
        maxSegments: input.maxSegments,
        sampleLimitPerSegment: input.sampleLimitPerSegment,
        trancheSize: input.trancheSize,
        cohortLimit,
        cohortCount: cohortCustomerIds.length,
        evidenceCutoffAt: evidenceCutoff.toISOString(),
        duplicate: false,
      };
    });
  }

  async getSegmentRun(
    context: TenantContext,
    runId: string,
  ): Promise<{
    id: string;
    brandId: string;
    brandName: string;
    status: string;
    maxSegments: number;
    sampleLimitPerSegment: number;
    trancheSize: number;
    cohortLimit: number;
    cohortCount: number;
    completedSegmentCount: number;
    evidenceCutoffAt: string;
    lastErrorCode: string | null;
    createdAt: string;
    updatedAt: string;
  }> {
    assertUuid(runId, "runId");
    return this.database.withTenant(context.organizationId, async (tx) => {
      const rows = await tx<
        Array<{
          id: string;
          brand_id: string;
          brand_name: string;
          status: string;
          max_segments: number;
          sample_limit_per_segment: number;
          tranche_size: number;
          cohort_limit: number;
          cohort_count: number;
          completed_segment_count: number;
          evidence_cutoff_at: Date;
          last_error_code: string | null;
          created_at: Date;
          updated_at: Date;
        }>
      >`
        SELECT
          run.id,
          run.brand_id,
          brand.name AS brand_name,
          run.status,
          run.max_segments,
          run.sample_limit_per_segment,
          run.tranche_size,
          run.cohort_limit,
          run.cohort_count,
          run.completed_segment_count,
          run.evidence_cutoff_at,
          run.last_error_code,
          run.created_at,
          run.updated_at
        FROM retention_segment_runs AS run
        INNER JOIN retention_brands AS brand
          ON brand.org_id = run.org_id
          AND brand.id = run.brand_id
        WHERE run.org_id = ${context.organizationId}
          AND run.id = ${runId}
      `;
      const row = rows[0];
      if (!row) {
        throw new RetentionServiceError(
          "segment_run_not_found",
          "The segment run is unavailable.",
          404,
        );
      }
      return {
        id: row.id,
        brandId: row.brand_id,
        brandName: row.brand_name,
        status: row.status,
        maxSegments: row.max_segments,
        sampleLimitPerSegment: row.sample_limit_per_segment,
        trancheSize: row.tranche_size,
        cohortLimit: row.cohort_limit,
        cohortCount: row.cohort_count,
        completedSegmentCount: row.completed_segment_count,
        evidenceCutoffAt: row.evidence_cutoff_at.toISOString(),
        lastErrorCode: row.last_error_code,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      };
    });
  }

  async claimSegmentRun(
    context: TenantContext,
    input: { runId: string; resume?: boolean },
  ): Promise<{
    runId: string;
    leaseOwner: string;
    leaseExpiresAt: string;
    dossierSha256: string;
    dossier: unknown;
    existingSegments: Array<{
      name: string;
      expression: WorklinSegmentExpression;
    }>;
    limits: {
      maxSegments: number;
      completedSegments: number;
      remainingSegments: number;
      trancheSize: number;
      sampleLimitPerSegment: number;
    };
  }> {
    assertUuid(input.runId, "runId");
    return this.database.withTenant(context.organizationId, async (tx) => {
      const rows = await tx<
        Array<{
          status: string;
          max_segments: number;
          sample_limit_per_segment: number;
          tranche_size: number;
          completed_segment_count: number;
          account_dossier_ciphertext: string;
          account_dossier_sha256: string;
          lease_expires_at: Date | null;
          attempt_count: number;
        }>
      >`
        SELECT
          status,
          max_segments,
          sample_limit_per_segment,
          tranche_size,
          completed_segment_count,
          account_dossier_ciphertext,
          account_dossier_sha256,
          lease_expires_at,
          attempt_count
        FROM retention_segment_runs
        WHERE org_id = ${context.organizationId}
          AND id = ${input.runId}
        FOR UPDATE
      `;
      const run = rows[0];
      if (!run) {
        throw new RetentionServiceError(
          "segment_run_not_found",
          "The segment run is unavailable.",
          404,
        );
      }
      if (run.status === "completed" || run.status === "failed") {
        throw new RetentionServiceError(
          "segment_run_finished",
          "The segment run has already finished.",
          409,
        );
      }
      if (run.status === "paused" && input.resume !== true) {
        throw new RetentionServiceError(
          "segment_run_paused",
          "The segment run is paused and must be explicitly resumed.",
          409,
        );
      }
      if (run.attempt_count >= this.options.maxJobAttempts) {
        throw new RetentionServiceError(
          "segment_run_attempt_limit",
          "The segment run reached its processing attempt limit.",
          409,
        );
      }
      if (
        run.status === "claimed" &&
        run.lease_expires_at &&
        run.lease_expires_at.getTime() > Date.now()
      ) {
        throw new RetentionServiceError(
          "segment_run_claimed",
          "The segment run is already being processed.",
          409,
        );
      }
      const leaseOwner = `segment-run:${randomUUID()}`;
      const leaseExpiresAt = new Date(
        Date.now() + this.options.jobLeaseSeconds * 1_000,
      );
      await tx`
        UPDATE retention_segment_runs
        SET
          status = 'claimed',
          lease_owner = ${leaseOwner},
          lease_expires_at = ${leaseExpiresAt},
          attempt_count = attempt_count + 1,
          claimed_at = now(),
          paused_at = NULL,
          last_error_code = NULL,
          updated_at = now()
        WHERE org_id = ${context.organizationId}
          AND id = ${input.runId}
      `;
      await this.audit(tx, context, {
        action: input.resume ? "segment_run.resumed" : "segment_run.claimed",
        resourceType: "segment_run",
        resourceId: input.runId,
      });
      const existingSegments = await tx<
        Array<{
          name: string;
          expression: WorklinSegmentExpression;
        }>
      >`
        SELECT name, expression
        FROM retention_segment_definitions
        WHERE org_id = ${context.organizationId}
          AND source_run_id = ${input.runId}
        ORDER BY created_at, id
        LIMIT 50
      `;
      return {
        runId: input.runId,
        leaseOwner,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        dossierSha256: run.account_dossier_sha256,
        dossier: JSON.parse(
          this.crypto.decrypt(
            run.account_dossier_ciphertext,
            `${context.organizationId}:segment-run:${input.runId}:dossier`,
          ),
        ),
        existingSegments,
        limits: {
          maxSegments: run.max_segments,
          completedSegments: run.completed_segment_count,
          remainingSegments: Math.max(
            0,
            run.max_segments - run.completed_segment_count,
          ),
          trancheSize: Math.min(
            run.tranche_size,
            run.max_segments - run.completed_segment_count,
          ),
          sampleLimitPerSegment: run.sample_limit_per_segment,
        },
      };
    });
  }

  async completeSegmentRun(
    context: TenantContext,
    input: SegmentRunCompletionInput,
  ): Promise<{
    runId: string;
    status: string;
    completedSegmentCount: number;
    definitions: Array<{
      id: string;
      name: string;
      version: number;
      checksum: string;
      memberCount: number;
      eligibleCount: number;
    }>;
  }> {
    assertUuid(input.runId, "runId");
    if (!input.leaseOwner.startsWith("segment-run:")) {
      throw new RetentionServiceError(
        "segment_run_lease_invalid",
        "The segment run lease is invalid.",
        409,
      );
    }
    return this.database.withTenant(context.organizationId, async (tx) => {
      const rows = await tx<
        Array<{
          brand_id: string;
          status: string;
          max_segments: number;
          sample_limit_per_segment: number;
          tranche_size: number;
          completed_segment_count: number;
          evidence_cutoff_at: Date;
          account_dossier_ciphertext: string;
          lease_owner: string | null;
          lease_expires_at: Date | null;
        }>
      >`
        SELECT
          brand_id,
          status,
          max_segments,
          sample_limit_per_segment,
          tranche_size,
          completed_segment_count,
          evidence_cutoff_at,
          account_dossier_ciphertext,
          lease_owner,
          lease_expires_at
        FROM retention_segment_runs
        WHERE org_id = ${context.organizationId}
          AND id = ${input.runId}
        FOR UPDATE
      `;
      const run = rows[0];
      if (!run) {
        throw new RetentionServiceError(
          "segment_run_not_found",
          "The segment run is unavailable.",
          404,
        );
      }
      if (
        run.status !== "claimed" ||
        run.lease_owner !== input.leaseOwner ||
        !run.lease_expires_at ||
        run.lease_expires_at.getTime() <= Date.now()
      ) {
        throw new RetentionServiceError(
          "segment_run_lease_expired",
          "The segment run lease expired or does not match.",
          409,
        );
      }
      const remaining = run.max_segments - run.completed_segment_count;
      const allowedTraitKeys = segmentTraitAllowlistFromDossier(
        JSON.parse(
          this.crypto.decrypt(
            run.account_dossier_ciphertext,
            `${context.organizationId}:segment-run:${input.runId}:dossier`,
          ),
        ),
      );
      if (
        input.definitions.length > run.tranche_size ||
        input.definitions.length > 10 ||
        input.definitions.length > remaining
      ) {
        throw new RetentionServiceError(
          "segment_tranche_too_large",
          "The segment completion exceeds its remaining tranche limit.",
          400,
        );
      }
      if (
        input.outcome !== "pause" &&
        input.definitions.length === 0 &&
        run.completed_segment_count === 0
      ) {
        throw new RetentionServiceError(
          "segment_definitions_required",
          "A completed segment run must contain at least one useful segment.",
          400,
        );
      }
      const names = new Set<string>();
      const sampleFingerprints = new Set<string>();
      const derivedQualityByName = new Map<
        string,
        { status: "passed" | "needs_review"; issues: string[] }
      >();
      const existingRunNames = await tx<Array<{ name: string }>>`
        SELECT name
        FROM retention_segment_definitions
        WHERE org_id = ${context.organizationId}
          AND source_run_id = ${input.runId}
      `;
      const usedNames = new Set(
        existingRunNames.map((row) => row.name.trim().toLocaleLowerCase()),
      );
      const trancheUsage = input.definitions.reduce(
        (total, definition) => ({
          inputTokens:
            total.inputTokens + definition.campaignPreview.usage.inputTokens,
          outputTokens:
            total.outputTokens + definition.campaignPreview.usage.outputTokens,
        }),
        { inputTokens: 0, outputTokens: 0 },
      );
      if (
        trancheUsage.inputTokens > 500_000 ||
        trancheUsage.outputTokens > 100_000
      ) {
        throw new RetentionServiceError(
          "segment_tranche_usage_limit",
          "The segment tranche exceeds its model usage limit.",
          400,
        );
      }
      for (const definition of input.definitions) {
        const normalizedName = definition.name.trim().toLocaleLowerCase();
        if (
          normalizedName.length === 0 ||
          definition.name.trim().length > 200 ||
          names.has(normalizedName) ||
          usedNames.has(normalizedName)
        ) {
          throw new RetentionServiceError(
            "invalid_segment_name",
            "Segment names must be unique, non-empty, and at most 200 characters.",
            400,
          );
        }
        names.add(normalizedName);
        assertConfidence(definition.confidence);
        const validation = validateSafeSegmentExpression(
          definition.expression,
          { allowedTraitKeys },
        );
        if (!validation.ok) {
          throw new RetentionServiceError(
            validation.code,
            validation.message,
            400,
          );
        }
        if (
          definition.campaignPreview.samples.length !==
          run.sample_limit_per_segment
        ) {
          throw new RetentionServiceError(
            "segment_sample_count_invalid",
            "The campaign preview must contain the run's exact sample count.",
            400,
          );
        }
        const qualityEvidence = buildMessageQualityEvidence({
          frozenStrategy: definition.campaignPreview.strategy,
          allowedTemplateTokens: [],
        });
        const qualityWarnings: string[] = [];
        for (const sample of definition.campaignPreview.samples) {
          if (
            !/^(?:customer_[a-f0-9]{12}|archetype_[a-z0-9_-]{1,64})$/u.test(
              sample.customerReference,
            )
          ) {
            throw new RetentionServiceError(
              "invalid_sample_customer_reference",
              "Campaign samples require an opaque customer reference.",
              400,
            );
          }
          const sampleText = [
            sample.subject,
            sample.preheader ?? "",
            sample.body,
            sample.explanation,
          ].join("\n");
          if (redactOperatorText(sampleText, []) !== sampleText) {
            throw new RetentionServiceError(
              "sample_contains_direct_identifier",
              "Campaign samples cannot contain email addresses or phone numbers.",
              400,
            );
          }
          const fingerprint = `${sample.subject}\n${sample.body}`
            .normalize("NFKC")
            .toLocaleLowerCase("en-US")
            .replace(/\s+/gu, " ")
            .trim();
          if (sampleFingerprints.has(fingerprint)) {
            throw new RetentionServiceError(
              "campaign_preview_repetitive",
              "Campaign samples must be distinct across the complete tranche.",
              400,
            );
          }
          sampleFingerprints.add(fingerprint);
          const quality = validateMessageQuality({
            content: {
              subject: sample.subject,
              preheader: sample.preheader,
              body: sample.body,
            },
            evidence: qualityEvidence,
          });
          if (!quality.valid) {
            throw new RetentionServiceError(
              "campaign_preview_quality_failed",
              "A campaign sample failed the server quality check.",
              400,
              {
                issues: quality.blockingErrors.map((issue) => issue.code),
              },
            );
          }
          qualityWarnings.push(
            ...quality.warnings.map(
              (issue) => `${issue.code}:${issue.field}:${issue.message}`,
            ),
          );
        }
        derivedQualityByName.set(normalizedName, {
          status: qualityWarnings.length > 0 ? "needs_review" : "passed",
          issues: qualityWarnings,
        });
      }

      const stored: StoredSegmentDefinition[] = [];
      for (const definition of input.definitions) {
        const versionRows = await tx<Array<{ version: number }>>`
          SELECT COALESCE(max(version), 0)::INTEGER + 1 AS version
          FROM retention_segment_definitions
          WHERE org_id = ${context.organizationId}
            AND brand_id = ${run.brand_id}
            AND lower(name) = lower(${definition.name.trim()})
        `;
        const version = versionRows[0]?.version ?? 1;
        const definitionId = randomUUID();
        const checksum = sha256(
          canonicalJson({
            brandId: run.brand_id,
            name: definition.name.trim(),
            version,
            expression: definition.expression,
          }),
        );
        const derivedQuality = derivedQualityByName.get(
          definition.name.trim().toLocaleLowerCase(),
        )!;
        await tx`
          INSERT INTO retention_segment_definitions (
            id,
            org_id,
            brand_id,
            name,
            version,
            expression,
            status,
            created_by,
            source_run_id,
            definition_checksum_sha256
          )
          VALUES (
            ${definitionId},
            ${context.organizationId},
            ${run.brand_id},
            ${definition.name.trim()},
            ${version},
            ${tx.json(JSON.parse(canonicalJson(definition.expression)))},
            'draft',
            ${context.userId},
            ${input.runId},
            ${checksum}
          )
        `;
        const previewId = randomUUID();
        await tx`
          INSERT INTO retention_campaign_previews (
            id,
            org_id,
            segment_run_id,
            segment_definition_id,
            strategy_ciphertext,
            evidence_ciphertext,
            quality_status,
            quality_issues_ciphertext,
            model_provider,
            model_id,
            prompt_version,
            usage
          )
          VALUES (
            ${previewId},
            ${context.organizationId},
            ${input.runId},
            ${definitionId},
            ${encryptedJson(
              this.crypto,
              {
                description: definition.description,
                confidence: definition.confidence,
                strategy: definition.campaignPreview.strategy,
              },
              `${context.organizationId}:campaign-preview:${previewId}:strategy`,
            )},
            ${encryptedJson(
              this.crypto,
              definition.evidence,
              `${context.organizationId}:campaign-preview:${previewId}:evidence`,
            )},
            ${derivedQuality.status},
            ${encryptedJson(
              this.crypto,
              derivedQuality.issues,
              `${context.organizationId}:campaign-preview:${previewId}:quality-issues`,
            )},
            ${definition.campaignPreview.modelProvider},
            ${definition.campaignPreview.modelId},
            ${definition.campaignPreview.promptVersion},
            ${tx.json(definition.campaignPreview.usage)}
          )
        `;
        for (const sample of definition.campaignPreview.samples) {
          const sampleId = randomUUID();
          const content = {
            subject: sample.subject,
            preheader: sample.preheader ?? null,
            body: sample.body,
          };
          await tx`
            INSERT INTO retention_campaign_preview_samples (
              id,
              org_id,
              campaign_preview_id,
              customer_reference_ciphertext,
              subject_ciphertext,
              preheader_ciphertext,
              body_ciphertext,
              explanation_ciphertext,
              message_sha256
            )
            VALUES (
              ${sampleId},
              ${context.organizationId},
              ${previewId},
              ${this.crypto.encrypt(
                sample.customerReference,
                `${context.organizationId}:campaign-preview-sample:${sampleId}:customer-reference`,
              )},
              ${this.crypto.encrypt(
                sample.subject,
                `${context.organizationId}:campaign-preview-sample:${sampleId}:subject`,
              )},
              ${
                sample.preheader
                  ? this.crypto.encrypt(
                      sample.preheader,
                      `${context.organizationId}:campaign-preview-sample:${sampleId}:preheader`,
                    )
                  : null
              },
              ${this.crypto.encrypt(
                sample.body,
                `${context.organizationId}:campaign-preview-sample:${sampleId}:body`,
              )},
              ${this.crypto.encrypt(
                sample.explanation,
                `${context.organizationId}:campaign-preview-sample:${sampleId}:explanation`,
              )},
              ${sha256(canonicalJson(content))}
            )
          `;
        }
        stored.push({
          id: definitionId,
          name: definition.name.trim(),
          version,
          checksum,
          expression: definition.expression,
        });
      }

      const counts = await this.evaluateSegmentMemberships(tx, {
        organizationId: context.organizationId,
        brandId: run.brand_id,
        runId: input.runId,
        evidenceCutoff: run.evidence_cutoff_at,
        definitions: stored,
      });
      const completedSegmentCount = run.completed_segment_count + stored.length;
      const status =
        input.outcome === "pause"
          ? "paused"
          : input.outcome === "complete" ||
              completedSegmentCount >= run.max_segments
            ? "completed"
            : "queued";
      await tx`
        UPDATE retention_segment_runs
        SET
          status = ${status},
          completed_segment_count = ${completedSegmentCount},
          lease_owner = NULL,
          lease_expires_at = NULL,
          paused_at = CASE WHEN ${status} = 'paused' THEN now() ELSE NULL END,
          completed_at = CASE
            WHEN ${status} = 'completed' THEN now()
            ELSE completed_at
          END,
          last_error_code = ${
            input.outcome === "pause"
              ? (input.errorCode ?? "generation_paused")
              : null
          },
          updated_at = now()
        WHERE org_id = ${context.organizationId}
          AND id = ${input.runId}
      `;
      await this.audit(tx, context, {
        action:
          status === "paused"
            ? "segment_run.paused"
            : status === "completed"
              ? "segment_run.completed"
              : "segment_run.tranche_completed",
        resourceType: "segment_run",
        resourceId: input.runId,
        metadata: {
          segmentCount: stored.length,
          completedSegmentCount,
          errorCode: input.errorCode ?? null,
        },
      });
      return {
        runId: input.runId,
        status,
        completedSegmentCount,
        definitions: stored.map((definition) => ({
          id: definition.id,
          name: definition.name,
          version: definition.version,
          checksum: definition.checksum,
          memberCount: counts.get(definition.id)?.memberCount ?? 0,
          eligibleCount: counts.get(definition.id)?.eligibleCount ?? 0,
        })),
      };
    });
  }

  async listSegments(
    context: TenantContext,
    input: { brandId: string; sourceRunId?: string },
  ): Promise<{ segments: unknown[] }> {
    assertUuid(input.brandId, "brandId");
    if (input.sourceRunId) {
      assertUuid(input.sourceRunId, "sourceRunId");
    }
    return this.database.withTenant(context.organizationId, async (tx) => {
      const rows = await tx<
        Array<{
          id: string;
          name: string;
          version: number;
          expression: WorklinSegmentExpression;
          status: string;
          definition_checksum_sha256: string | null;
          source_run_id: string | null;
          created_at: Date;
          member_count: string;
          eligible_count: string;
          preview_id: string | null;
          strategy_ciphertext: string | null;
          evidence_ciphertext: string | null;
          quality_status: string | null;
          quality_issues_ciphertext: string | null;
          model_provider: string | null;
          model_id: string | null;
          prompt_version: string | null;
          usage: unknown;
        }>
      >`
        SELECT
          definition.id,
          definition.name,
          definition.version,
          definition.expression,
          definition.status,
          definition.definition_checksum_sha256,
          definition.source_run_id,
          definition.created_at,
          count(membership.customer_id)::TEXT AS member_count,
          count(membership.customer_id) FILTER (
            WHERE membership.campaign_eligible
          )::TEXT AS eligible_count,
          preview.id AS preview_id,
          preview.strategy_ciphertext,
          preview.evidence_ciphertext,
          preview.quality_status,
          preview.quality_issues_ciphertext,
          preview.model_provider,
          preview.model_id,
          preview.prompt_version,
          preview.usage
        FROM retention_segment_definitions AS definition
        LEFT JOIN retention_segment_memberships AS membership
          ON membership.org_id = definition.org_id
          AND membership.segment_definition_id = definition.id
        LEFT JOIN retention_campaign_previews AS preview
          ON preview.org_id = definition.org_id
          AND preview.segment_definition_id = definition.id
        WHERE definition.org_id = ${context.organizationId}
          AND definition.brand_id = ${input.brandId}
          AND definition.source_run_id IS NOT NULL
          AND (
            ${input.sourceRunId ?? null}::UUID IS NULL
            OR definition.source_run_id = ${input.sourceRunId ?? null}
          )
          AND definition.status <> 'archived'
        GROUP BY definition.id, preview.id
        ORDER BY
          CASE WHEN definition.status = 'active' THEN 0 ELSE 1 END,
          definition.created_at DESC,
          definition.name
      `;
      const previewIds = rows
        .map((row) => row.preview_id)
        .filter((value): value is string => value !== null);
      const sampleRows =
        previewIds.length === 0
          ? []
          : await tx<
              Array<{
                id: string;
                campaign_preview_id: string;
                customer_reference_ciphertext: string;
                subject_ciphertext: string;
                preheader_ciphertext: string | null;
                body_ciphertext: string;
                explanation_ciphertext: string;
                message_sha256: string;
              }>
            >`
            SELECT
              id,
              campaign_preview_id,
              customer_reference_ciphertext,
              subject_ciphertext,
              preheader_ciphertext,
              body_ciphertext,
              explanation_ciphertext,
              message_sha256
            FROM retention_campaign_preview_samples
            WHERE org_id = ${context.organizationId}
              AND campaign_preview_id = ANY(${tx.array(previewIds)}::UUID[])
            ORDER BY created_at, id
          `;
      return {
        segments: rows.map((row) => ({
          id: row.id,
          name: row.name,
          version: row.version,
          expression: row.expression,
          status: row.status,
          checksum: row.definition_checksum_sha256,
          sourceRunId: row.source_run_id,
          memberCount: Number(row.member_count),
          eligibleCount: Number(row.eligible_count),
          createdAt: row.created_at.toISOString(),
          campaignPreview:
            row.preview_id &&
            row.strategy_ciphertext &&
            row.evidence_ciphertext &&
            row.quality_issues_ciphertext
              ? {
                  ...JSON.parse(
                    this.crypto.decrypt(
                      row.strategy_ciphertext,
                      `${context.organizationId}:campaign-preview:${row.preview_id}:strategy`,
                    ),
                  ),
                  evidence: JSON.parse(
                    this.crypto.decrypt(
                      row.evidence_ciphertext,
                      `${context.organizationId}:campaign-preview:${row.preview_id}:evidence`,
                    ),
                  ),
                  qualityStatus: row.quality_status,
                  qualityIssues: JSON.parse(
                    this.crypto.decrypt(
                      row.quality_issues_ciphertext,
                      `${context.organizationId}:campaign-preview:${row.preview_id}:quality-issues`,
                    ),
                  ),
                  model: {
                    provider: row.model_provider,
                    id: row.model_id,
                    promptVersion: row.prompt_version,
                  },
                  usage: row.usage,
                  samples: sampleRows
                    .filter(
                      (sample) => sample.campaign_preview_id === row.preview_id,
                    )
                    .map((sample) => ({
                      customerReference: this.crypto.decrypt(
                        sample.customer_reference_ciphertext,
                        `${context.organizationId}:campaign-preview-sample:${sample.id}:customer-reference`,
                      ),
                      subject: this.crypto.decrypt(
                        sample.subject_ciphertext,
                        `${context.organizationId}:campaign-preview-sample:${sample.id}:subject`,
                      ),
                      preheader: sample.preheader_ciphertext
                        ? this.crypto.decrypt(
                            sample.preheader_ciphertext,
                            `${context.organizationId}:campaign-preview-sample:${sample.id}:preheader`,
                          )
                        : null,
                      body: this.crypto.decrypt(
                        sample.body_ciphertext,
                        `${context.organizationId}:campaign-preview-sample:${sample.id}:body`,
                      ),
                      explanation: this.crypto.decrypt(
                        sample.explanation_ciphertext,
                        `${context.organizationId}:campaign-preview-sample:${sample.id}:explanation`,
                      ),
                      checksum: sample.message_sha256,
                    })),
                }
              : null,
        })),
      };
    });
  }

  async listSegmentsForRun(
    context: TenantContext,
    runId: string,
  ): Promise<{ brandName: string; segments: unknown[] }> {
    assertUuid(runId, "runId");
    const run = await this.database.withTenant(
      context.organizationId,
      async (tx) => {
        const rows = await tx<Array<{ brand_id: string; brand_name: string }>>`
          SELECT run.brand_id, brand.name AS brand_name
          FROM retention_segment_runs AS run
          INNER JOIN retention_brands AS brand
            ON brand.org_id = run.org_id
            AND brand.id = run.brand_id
          WHERE run.org_id = ${context.organizationId}
            AND run.id = ${runId}
        `;
        if (!rows[0]) {
          throw new RetentionServiceError(
            "segment_run_not_found",
            "The segment review run is unavailable.",
            404,
          );
        }
        return {
          brandId: rows[0].brand_id,
          brandName: rows[0].brand_name,
        };
      },
    );
    const result = await this.listSegments(context, {
      brandId: run.brandId,
      sourceRunId: runId,
    });
    return { brandName: run.brandName, segments: result.segments };
  }

  async activateSegment(
    context: TenantContext,
    input: {
      segmentId: string;
      expectedVersion: number;
      expectedChecksum: string;
    },
  ): Promise<{
    segmentId: string;
    status: "active";
    version: number;
    checksum: string;
    duplicate: boolean;
  }> {
    assertUuid(input.segmentId, "segmentId");
    assertSha256(input.expectedChecksum, "expectedChecksum");
    return this.database.withTenant(context.organizationId, async (tx) => {
      const rows = await tx<
        Array<{
          brand_id: string;
          name: string;
          version: number;
          status: string;
          definition_checksum_sha256: string | null;
          run_status: string | null;
        }>
      >`
        SELECT
          definition.brand_id,
          definition.name,
          definition.version,
          definition.status,
          definition.definition_checksum_sha256,
          run.status AS run_status
        FROM retention_segment_definitions AS definition
        LEFT JOIN retention_segment_runs AS run
          ON run.org_id = definition.org_id
          AND run.id = definition.source_run_id
        WHERE definition.org_id = ${context.organizationId}
          AND definition.id = ${input.segmentId}
        FOR UPDATE OF definition
      `;
      const segment = rows[0];
      if (!segment) {
        throw new RetentionServiceError(
          "segment_not_found",
          "The segment definition is unavailable.",
          404,
        );
      }
      if (
        segment.version !== input.expectedVersion ||
        segment.definition_checksum_sha256 !== input.expectedChecksum
      ) {
        throw new RetentionServiceError(
          "segment_activation_stale",
          "The segment changed after it was reviewed.",
          409,
        );
      }
      if (segment.run_status !== "completed") {
        throw new RetentionServiceError(
          "segment_run_incomplete",
          "The full segment review run must finish before activation.",
          409,
        );
      }
      if (segment.status === "active") {
        return {
          segmentId: input.segmentId,
          status: "active",
          version: segment.version,
          checksum: input.expectedChecksum,
          duplicate: true,
        };
      }
      await tx`
        UPDATE retention_segment_definitions
        SET status = 'archived', updated_at = now()
        WHERE org_id = ${context.organizationId}
          AND brand_id = ${segment.brand_id}
          AND lower(name) = lower(${segment.name})
          AND status = 'active'
          AND id <> ${input.segmentId}
      `;
      await tx`
        UPDATE retention_segment_definitions
        SET
          status = 'active',
          activated_by = ${context.userId},
          activated_at = now(),
          updated_at = now()
        WHERE org_id = ${context.organizationId}
          AND id = ${input.segmentId}
      `;
      await this.audit(tx, context, {
        action: "segment_definition.activated",
        resourceType: "segment_definition",
        resourceId: input.segmentId,
        metadata: {
          version: segment.version,
          checksum: input.expectedChecksum,
        },
      });
      return {
        segmentId: input.segmentId,
        status: "active",
        version: segment.version,
        checksum: input.expectedChecksum,
        duplicate: false,
      };
    });
  }

  async claimRecipientReasoning(context: TenantContext): Promise<{
    jobId: string;
    leaseOwner: string;
    decisionId: string;
    customerId: string;
    programId: string;
    dossierSha256: string;
    dossier: {
      customerReference: string;
      displayName: string | null;
      program: {
        type: RetentionProgram;
        policyVersion: string;
        policy: unknown;
      };
      evidenceCutoffAt: string;
      consent: Array<{
        channel: string;
        state: string;
        occurredAt: string;
      }>;
      traits: Array<{
        id: string;
        key: string;
        value: unknown;
        evidenceKind: string;
        sensitivity: string;
        confidence: number;
        targetingStatus: string;
        observedAt: string;
        expiresAt: string | null;
      }>;
      recentEvents: Array<{
        id: string;
        provider: string;
        type: string;
        occurredAt: string;
      }>;
      features: unknown | null;
    };
  } | null> {
    const leaseOwner = `reasoning:${randomUUID()}`;
    const job = await this.claimJob(context.organizationId, leaseOwner, [
      "reason_customer",
    ]);
    if (!job) return null;
    const payload =
      job.payload && typeof job.payload === "object"
        ? (job.payload as Record<string, unknown>)
        : {};
    const decisionId =
      typeof payload.decisionId === "string" ? payload.decisionId : "";
    const customerId =
      typeof payload.customerId === "string" ? payload.customerId : "";
    const programId =
      typeof payload.programId === "string" ? payload.programId : "";
    try {
      assertUuid(decisionId, "decisionId");
      assertUuid(customerId, "customerId");
      assertUuid(programId, "programId");
      const result = await this.database.withTenant(
        context.organizationId,
        async (tx) => {
          const decisions = await tx<
            Array<{
              input_evidence_cutoff_at: Date;
              display_name_ciphertext: string | null;
              program_type: RetentionProgram;
              policy_version: string;
              policy: unknown;
              sensitive_targeting_enabled: boolean;
              lawful_basis_recorded_at: Date | null;
            }>
          >`
            SELECT
              decision.input_evidence_cutoff_at,
              customer.display_name_ciphertext,
              program.program_type,
              program.policy_version,
              program.policy,
              settings.sensitive_targeting_enabled,
              settings.lawful_basis_recorded_at
            FROM retention_customer_decisions AS decision
            JOIN retention_customers AS customer
              ON customer.org_id = decision.org_id
              AND customer.id = decision.customer_id
            JOIN retention_programs AS program
              ON program.org_id = decision.org_id
              AND program.id = decision.program_id
            JOIN retention_org_settings AS settings
              ON settings.org_id = decision.org_id
            WHERE decision.org_id = ${context.organizationId}
              AND decision.id = ${decisionId}
              AND decision.customer_id = ${customerId}
              AND decision.program_id = ${programId}
              AND decision.status = 'pending_reasoning'
              AND decision.invalidated_at IS NULL
          `;
          const decision = decisions[0];
          if (!decision) return null;
          const consentRows = await tx<
            Array<{
              channel: string;
              state: string;
              occurred_at: Date;
            }>
          >`
            SELECT DISTINCT ON (channel)
              channel,
              state,
              occurred_at
            FROM retention_consent_events
            WHERE org_id = ${context.organizationId}
              AND customer_id = ${customerId}
              AND occurred_at <= ${decision.input_evidence_cutoff_at}
            ORDER BY channel, occurred_at DESC, created_at DESC
          `;
          const allowSensitive =
            decision.sensitive_targeting_enabled &&
            decision.lawful_basis_recorded_at !== null;
          const traitRows = await tx<
            Array<{
              id: string;
              trait_key: string;
              value_ciphertext: string;
              evidence_kind: string;
              sensitivity: string;
              confidence: string;
              targeting_status: string;
              observed_at: Date;
              expires_at: Date | null;
            }>
          >`
            SELECT
              id,
              trait_key,
              value_ciphertext,
              evidence_kind,
              sensitivity,
              confidence::TEXT,
              targeting_status,
              observed_at,
              expires_at
            FROM retention_customer_traits
            WHERE org_id = ${context.organizationId}
              AND customer_id = ${customerId}
              AND observed_at <= ${decision.input_evidence_cutoff_at}
              AND (expires_at IS NULL OR expires_at > now())
              AND targeting_status NOT IN ('rejected', 'expired')
              AND (
                sensitivity IN ('standard', 'personal')
                OR (${allowSensitive} AND targeting_status = 'approved')
              )
            ORDER BY observed_at DESC, id
            LIMIT 100
          `;
          const eventRows = await tx<
            Array<{
              id: string;
              provider: string;
              event_type: string;
              occurred_at: Date;
            }>
          >`
            SELECT id, provider, event_type, occurred_at
            FROM retention_source_events
            WHERE org_id = ${context.organizationId}
              AND customer_id = ${customerId}
              AND occurred_at <= ${decision.input_evidence_cutoff_at}
              AND processing_status IN ('processed', 'ignored')
            ORDER BY occurred_at DESC, id
            LIMIT 50
          `;
          const featureRows = await tx<Array<{ features: unknown }>>`
            SELECT features
            FROM retention_feature_snapshots
            WHERE org_id = ${context.organizationId}
              AND customer_id = ${customerId}
              AND evidence_cutoff_at <= ${decision.input_evidence_cutoff_at}
              AND invalidated_at IS NULL
            ORDER BY computed_at DESC, id
            LIMIT 1
          `;
          const dossier = {
            customerReference: operatorCustomerReference(
              context.organizationId,
              customerId,
            ),
            displayName: this.decryptCustomerDisplayName(
              context.organizationId,
              customerId,
              decision.display_name_ciphertext,
            ),
            program: {
              type: decision.program_type,
              policyVersion: decision.policy_version,
              policy: decision.policy,
            },
            evidenceCutoffAt: decision.input_evidence_cutoff_at.toISOString(),
            consent: consentRows.map((row) => ({
              channel: row.channel,
              state: row.state,
              occurredAt: row.occurred_at.toISOString(),
            })),
            traits: traitRows.map((row) => ({
              id: row.id,
              key: row.trait_key,
              value: JSON.parse(
                this.crypto.decrypt(
                  row.value_ciphertext,
                  `${context.organizationId}:trait:${row.id}:value`,
                ),
              ),
              evidenceKind: row.evidence_kind,
              sensitivity: row.sensitivity,
              confidence: Number(row.confidence),
              targetingStatus: row.targeting_status,
              observedAt: row.observed_at.toISOString(),
              expiresAt: row.expires_at?.toISOString() ?? null,
            })),
            recentEvents: eventRows.map((row) => ({
              id: row.id,
              provider: row.provider,
              type: row.event_type,
              occurredAt: row.occurred_at.toISOString(),
            })),
            features: featureRows[0]?.features ?? null,
          };
          const dossierSha256 = sha256(canonicalJson(dossier));
          const updated = await tx`
            UPDATE retention_customer_decisions
            SET dossier_sha256 = ${dossierSha256}, updated_at = now()
            WHERE org_id = ${context.organizationId}
              AND id = ${decisionId}
              AND status = 'pending_reasoning'
              AND invalidated_at IS NULL
            RETURNING id
          `;
          if (updated.length === 0) return null;
          await this.audit(tx, context, {
            action: "customer_decision.reasoning_claimed",
            resourceType: "customer_decision",
            resourceId: decisionId,
            metadata: {
              jobId: job.id,
              dossierSha256,
              attempt: job.attempts,
            },
          });
          return { dossier, dossierSha256 };
        },
      );
      if (!result) {
        await this.completeJob(context.organizationId, leaseOwner, job.id);
        return null;
      }
      return {
        jobId: job.id,
        leaseOwner,
        decisionId,
        customerId,
        programId,
        dossierSha256: result.dossierSha256,
        dossier: result.dossier,
      };
    } catch (error) {
      await this.failJob(context.organizationId, leaseOwner, job.id, {
        code:
          error instanceof RetentionServiceError
            ? error.code
            : "reasoning_claim_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async recordRecipientDecision(
    context: TenantContext,
    input: {
      jobId: string;
      leaseOwner: string;
      decisionId: string;
      customerId: string;
      programId: string;
      status: "eligible" | "ineligible" | "needs_review";
      dossierSha256: string;
      objective: string;
      rationale: string;
      recommendation: {
        action: string;
        channel: "email";
        timing?: string;
        offer?: string;
        personalizationBrief: string;
      };
      hypotheses: Array<{
        id: string;
        statement: string;
        confidence: number;
        evidenceIds: string[];
      }>;
      evidenceIds: string[];
      confidence: number;
      sensitivity: "standard" | "personal" | "sensitive" | "restricted";
      requiresHumanReview: boolean;
      model: {
        provider: string;
        id: string;
        promptVersion: string;
        responseId?: string;
      };
      generatedAt: string;
      evidenceCutoffAt: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens?: number;
        estimatedProviderCost?: number;
      };
    },
  ): Promise<{ decisionId: string; status: string }> {
    assertUuid(input.jobId, "jobId");
    if (
      !input.leaseOwner.startsWith("reasoning:") ||
      input.leaseOwner.length > 128
    ) {
      throw new RetentionServiceError(
        "invalid_reasoning_lease",
        "The recipient reasoning lease is invalid.",
        400,
      );
    }
    assertUuid(input.decisionId, "decisionId");
    assertUuid(input.customerId, "customerId");
    assertUuid(input.programId, "programId");
    assertSha256(input.dossierSha256, "dossierSha256");
    assertConfidence(input.confidence);
    for (const evidenceId of input.evidenceIds) {
      assertUuid(evidenceId, "evidenceId");
    }
    const decisionEvidenceIds = new Set(input.evidenceIds);
    for (const hypothesis of input.hypotheses) {
      for (const evidenceId of hypothesis.evidenceIds) {
        assertUuid(evidenceId, "hypothesisEvidenceId");
        if (!decisionEvidenceIds.has(evidenceId)) {
          throw new RetentionServiceError(
            "unsupported_decision_evidence",
            "Every hypothesis must reference evidence included in the recipient decision.",
            400,
          );
        }
      }
    }
    if (
      (input.sensitivity === "sensitive" ||
        input.sensitivity === "restricted") &&
      !input.requiresHumanReview
    ) {
      throw new RetentionServiceError(
        "sensitive_review_required",
        "Sensitive recipient decisions require human review.",
        409,
      );
    }
    const generatedAt = new Date(input.generatedAt);
    const evidenceCutoffAt = new Date(input.evidenceCutoffAt);
    const recommendedTiming = input.recommendation.timing
      ? new Date(input.recommendation.timing)
      : null;
    if (
      Number.isNaN(generatedAt.valueOf()) ||
      Number.isNaN(evidenceCutoffAt.valueOf())
    ) {
      throw new RetentionServiceError(
        "invalid_decision_timestamp",
        "Decision timestamps must be valid ISO dates.",
        400,
      );
    }
    const program = await this.database.withTenant(
      context.organizationId,
      async (tx) => {
        const rows = await tx<
          Array<{ program_type: RetentionProgram; brand_id: string }>
        >`
          SELECT program_type, brand_id
          FROM retention_programs
          WHERE org_id = ${context.organizationId}
            AND id = ${input.programId}
        `;
        return rows[0] ?? null;
      },
    );
    if (!program) {
      throw new RetentionServiceError(
        "program_not_found",
        "The retention program was not found.",
        404,
      );
    }
    const decisionValidation = createAiRecipientDecision({
      id: input.decisionId,
      orgId: context.organizationId,
      customerId: input.customerId,
      program: program.program_type,
      status: "proposed",
      dossierChecksum: input.dossierSha256,
      model: {
        provider: input.model.provider,
        model: input.model.id,
        promptVersion: input.model.promptVersion,
        ...(input.model.responseId
          ? { responseId: input.model.responseId }
          : {}),
      },
      generatedAt: generatedAt.toISOString(),
      objective: input.objective,
      rationale: input.rationale,
      recommendation: input.recommendation,
      hypotheses: input.hypotheses,
      evidenceIds: input.evidenceIds,
      confidence: input.confidence,
      sensitivity: input.sensitivity,
      requiresHumanReview: input.requiresHumanReview,
      ...(input.usage
        ? {
            usage: {
              inputTokens: input.usage.inputTokens,
              outputTokens: input.usage.outputTokens,
              ...(input.usage.cachedInputTokens !== undefined
                ? { cachedInputTokens: input.usage.cachedInputTokens }
                : {}),
              ...(input.usage.estimatedProviderCost !== undefined
                ? {
                    estimatedProviderCost: input.usage.estimatedProviderCost,
                    currency: "USD",
                  }
                : {}),
            },
          }
        : {}),
    });
    if (!decisionValidation.ok) {
      throw new RetentionServiceError(
        decisionValidation.error.code,
        decisionValidation.error.message,
        400,
        decisionValidation.error.details
          ? { ...decisionValidation.error.details }
          : undefined,
      );
    }

    return this.database.withTenant(context.organizationId, async (tx) => {
      const jobs = await tx<Array<{ payload_ciphertext: string }>>`
        SELECT payload_ciphertext
        FROM retention_jobs
        WHERE org_id = ${context.organizationId}
          AND id = ${input.jobId}
          AND job_type = 'reason_customer'
          AND status = 'running'
          AND lease_owner = ${input.leaseOwner}
          AND lease_expires_at > now()
        FOR UPDATE
      `;
      const jobPayload = jobs[0]
        ? (JSON.parse(
            this.crypto.decrypt(
              jobs[0].payload_ciphertext,
              `${context.organizationId}:job:${input.jobId}:payload`,
            ),
          ) as Record<string, unknown>)
        : null;
      if (
        !jobPayload ||
        jobPayload.decisionId !== input.decisionId ||
        jobPayload.customerId !== input.customerId ||
        jobPayload.programId !== input.programId
      ) {
        throw new RetentionServiceError(
          "reasoning_lease_lost",
          "The recipient reasoning lease expired or no longer matches this decision.",
          409,
        );
      }
      const decisionState = await tx<
        Array<{
          dossier_sha256: string | null;
          input_evidence_cutoff_at: Date;
        }>
      >`
        SELECT dossier_sha256, input_evidence_cutoff_at
        FROM retention_customer_decisions
        WHERE org_id = ${context.organizationId}
          AND id = ${input.decisionId}
          AND customer_id = ${input.customerId}
          AND program_id = ${input.programId}
          AND status = 'pending_reasoning'
          AND invalidated_at IS NULL
        FOR UPDATE
      `;
      const state = decisionState[0];
      if (
        !state ||
        state.dossier_sha256 !== input.dossierSha256 ||
        state.input_evidence_cutoff_at.getTime() !== evidenceCutoffAt.getTime()
      ) {
        throw new RetentionServiceError(
          "decision_evidence_changed",
          "The customer evidence changed after this reasoning task was claimed.",
          409,
        );
      }
      const verifiedEvidence = await tx<Array<{ id: string }>>`
        SELECT id
        FROM retention_source_events
        WHERE org_id = ${context.organizationId}
          AND customer_id = ${input.customerId}
          AND id = ANY(${tx.array(input.evidenceIds)}::UUID[])
          AND occurred_at <= ${state.input_evidence_cutoff_at}
          AND processing_status IN ('processed', 'ignored')
      `;
      if (verifiedEvidence.length !== decisionEvidenceIds.size) {
        throw new RetentionServiceError(
          "unsupported_decision_evidence",
          "The recipient decision references missing, stale, or unrelated evidence.",
          400,
        );
      }
      const updated = await tx<Array<{ id: string }>>`
        UPDATE retention_customer_decisions
        SET
          status = ${input.status},
          objective = ${input.objective},
          recommended_timing = ${
            recommendedTiming && !Number.isNaN(recommendedTiming.valueOf())
              ? recommendedTiming
              : null
          },
          recommended_offer = ${tx.json({
            offer: input.recommendation.offer ?? null,
            action: input.recommendation.action,
            channel: input.recommendation.channel,
            timing: input.recommendation.timing ?? null,
            personalizationBrief: input.recommendation.personalizationBrief,
          })},
          reasoning_ciphertext = ${encryptedJson(
            this.crypto,
            {
              rationale: input.rationale,
              responseId: input.model.responseId ?? null,
            },
            `${context.organizationId}:decision:${input.decisionId}:reasoning`,
          )},
          competing_hypotheses_ciphertext = ${encryptedJson(
            this.crypto,
            input.hypotheses,
            `${context.organizationId}:decision:${input.decisionId}:hypotheses`,
          )},
          dossier_sha256 = ${input.dossierSha256},
          evidence_event_ids = ${tx.array(input.evidenceIds)}::UUID[],
          sensitivity = ${input.sensitivity},
          requires_human_review = ${input.requiresHumanReview},
          confidence = ${input.confidence},
          model_provider = ${input.model.provider},
          model_id = ${input.model.id},
          prompt_version = ${input.model.promptVersion},
          input_evidence_cutoff_at = ${evidenceCutoffAt},
          reasoned_at = ${generatedAt},
          invalidated_at = NULL,
          updated_at = now()
        WHERE org_id = ${context.organizationId}
          AND id = ${input.decisionId}
          AND customer_id = ${input.customerId}
          AND program_id = ${input.programId}
          AND status = 'pending_reasoning'
          AND dossier_sha256 = ${input.dossierSha256}
        RETURNING id
      `;
      if (updated.length === 0) {
        throw new RetentionServiceError(
          "decision_not_pending",
          "The recipient decision is missing, stale, or already completed.",
          409,
        );
      }
      if (input.usage) {
        const estimatedCost = input.usage.estimatedProviderCost ?? null;
        if (estimatedCost !== null) {
          assertNonNegativeMoney(estimatedCost, "estimatedProviderCost");
        }
        await tx`
          INSERT INTO retention_usage_events (
            id,
            org_id,
            customer_id,
            purpose,
            provider,
            model,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            estimated_cost_usd
          )
          VALUES (
            ${randomUUID()},
            ${context.organizationId},
            ${input.customerId},
            'recipient_decision',
            ${input.model.provider},
            ${input.model.id},
            ${input.usage.inputTokens},
            ${input.usage.outputTokens},
            ${input.usage.cachedInputTokens ?? 0},
            ${estimatedCost}
          )
        `;
      }
      const completed = await tx`
        UPDATE retention_jobs
        SET
          status = 'completed',
          completed_at = now(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
        WHERE org_id = ${context.organizationId}
          AND id = ${input.jobId}
          AND status = 'running'
          AND lease_owner = ${input.leaseOwner}
        RETURNING id
      `;
      if (completed.length === 0) {
        throw new RetentionServiceError(
          "reasoning_lease_lost",
          "The recipient reasoning lease expired before completion.",
          409,
        );
      }
      await this.audit(tx, context, {
        action: "customer_decision.recorded",
        resourceType: "customer_decision",
        resourceId: input.decisionId,
        metadata: {
          status: input.status,
          sensitivity: input.sensitivity,
          requiresHumanReview: input.requiresHumanReview,
        },
      });
      return { decisionId: input.decisionId, status: input.status };
    });
  }

  async createCampaign(
    context: TenantContext,
    input: {
      brandId: string;
      programId: string;
      segmentDefinitionId?: string;
      mode: RetentionCampaignMode;
      name: string;
    },
  ): Promise<{ id: string; status: "draft"; mode: RetentionCampaignMode }> {
    assertUuid(input.brandId, "brandId");
    assertUuid(input.programId, "programId");
    if (input.segmentDefinitionId) {
      assertUuid(input.segmentDefinitionId, "segmentDefinitionId");
    }
    const id = randomUUID();
    await this.database.withTenant(context.organizationId, async (tx) => {
      await tx`
        INSERT INTO retention_campaigns (
          id,
          org_id,
          brand_id,
          program_id,
          segment_definition_id,
          mode,
          name,
          status,
          created_by
        )
        VALUES (
          ${id},
          ${context.organizationId},
          ${input.brandId},
          ${input.programId},
          ${input.segmentDefinitionId ?? null},
          ${input.mode},
          ${input.name.trim()},
          'draft',
          ${context.userId}
        )
      `;
      await this.audit(tx, context, {
        action: "campaign.created",
        resourceType: "campaign",
        resourceId: id,
        metadata: { mode: input.mode },
      });
    });
    return { id, status: "draft", mode: input.mode };
  }

  async freezeCampaignAudience(
    context: TenantContext,
    input: {
      campaignId: string;
      definitionVersion: number;
      evidenceCutoffAt: string;
      members: Array<{
        customerId: string;
        decisionId: string;
        inclusionExplanation: string;
      }>;
    },
  ): Promise<{
    campaignId: string;
    audienceSnapshotId: string;
    snapshotSha256: string;
    memberCount: number;
    sensitiveMemberCount: number;
    duplicate: boolean;
  }> {
    assertUuid(input.campaignId, "campaignId");
    if (input.members.length === 0 || input.members.length > 10_000) {
      throw new RetentionServiceError(
        "invalid_audience",
        "An audience must contain between 1 and 10,000 recipients per freeze request.",
        400,
      );
    }
    const evidenceCutoffAt = new Date(input.evidenceCutoffAt);
    if (Number.isNaN(evidenceCutoffAt.valueOf())) {
      throw new RetentionServiceError(
        "invalid_audience_timestamp",
        "The audience evidence cutoff must be a valid ISO date.",
        400,
      );
    }
    const uniqueCustomers = new Set<string>();
    const normalizedMembers = input.members
      .map((member) => {
        assertUuid(member.customerId, "customerId");
        assertUuid(member.decisionId, "decisionId");
        if (uniqueCustomers.has(member.customerId)) {
          throw new RetentionServiceError(
            "duplicate_audience_member",
            "A customer cannot appear twice in one audience.",
            400,
          );
        }
        uniqueCustomers.add(member.customerId);
        return {
          customerId: member.customerId,
          decisionId: member.decisionId,
          inclusionExplanation: member.inclusionExplanation.trim(),
        };
      })
      .sort((left, right) => left.customerId.localeCompare(right.customerId));
    const snapshotSha256 = sha256(
      canonicalJson({
        campaignId: input.campaignId,
        definitionVersion: input.definitionVersion,
        evidenceCutoffAt: evidenceCutoffAt.toISOString(),
        members: normalizedMembers.map((member) => ({
          customerId: member.customerId,
          decisionId: member.decisionId,
        })),
      }),
    );

    return this.database.withTenant(context.organizationId, async (tx) => {
      const campaigns = await tx<
        Array<{
          status: string;
          program_id: string;
          existing_snapshot_id: string | null;
          existing_sha256: string | null;
        }>
      >`
        SELECT
          campaign.status,
          campaign.program_id,
          audience.id AS existing_snapshot_id,
          audience.snapshot_sha256 AS existing_sha256
        FROM retention_campaigns AS campaign
        LEFT JOIN retention_audience_snapshots AS audience
          ON audience.org_id = campaign.org_id
          AND audience.campaign_id = campaign.id
        WHERE campaign.org_id = ${context.organizationId}
          AND campaign.id = ${input.campaignId}
        FOR UPDATE OF campaign
      `;
      const campaign = campaigns[0];
      if (!campaign) {
        throw new RetentionServiceError(
          "campaign_not_found",
          "The retention campaign was not found.",
          404,
        );
      }
      if (
        campaign.existing_snapshot_id &&
        campaign.existing_sha256 === snapshotSha256
      ) {
        const counts = await tx<
          Array<{ member_count: string; sensitive_member_count: string }>
        >`
          SELECT
            member_count::TEXT,
            sensitive_member_count::TEXT
          FROM retention_audience_snapshots
          WHERE org_id = ${context.organizationId}
            AND id = ${campaign.existing_snapshot_id}
        `;
        return {
          campaignId: input.campaignId,
          audienceSnapshotId: campaign.existing_snapshot_id,
          snapshotSha256,
          memberCount: Number(counts[0]?.member_count ?? 0),
          sensitiveMemberCount: Number(counts[0]?.sensitive_member_count ?? 0),
          duplicate: true,
        };
      }
      if (
        campaign.status !== "draft" &&
        campaign.status !== "audience_frozen" &&
        campaign.status !== "review_required" &&
        campaign.status !== "approved"
      ) {
        throw new RetentionServiceError(
          "campaign_not_freezable",
          "The campaign audience cannot be changed in its current state.",
          409,
        );
      }
      const settings = await tx<
        Array<{
          sensitive_targeting_enabled: boolean;
          lawful_basis_recorded_at: Date | null;
        }>
      >`
        SELECT sensitive_targeting_enabled, lawful_basis_recorded_at
        FROM retention_org_settings
        WHERE org_id = ${context.organizationId}
      `;
      let sensitiveMemberCount = 0;
      const verifiedMembers: Array<{
        customerId: string;
        decisionId: string;
        inclusionExplanation: string;
        sensitiveInferenceUsed: boolean;
        consentState: string;
      }> = [];
      for (const member of normalizedMembers) {
        const decisions = await tx<
          Array<{
            status: string;
            sensitivity: string;
            requires_human_review: boolean;
            input_evidence_cutoff_at: Date;
            invalidated_at: Date | null;
            consent_state: string | null;
          }>
        >`
          SELECT
            decision.status,
            decision.sensitivity,
            decision.requires_human_review,
            decision.input_evidence_cutoff_at,
            decision.invalidated_at,
            consent.state AS consent_state
          FROM retention_customer_decisions AS decision
          LEFT JOIN LATERAL (
            SELECT state
            FROM retention_consent_events
            WHERE org_id = decision.org_id
              AND customer_id = decision.customer_id
              AND channel = 'email'
              AND occurred_at <= ${evidenceCutoffAt}
            ORDER BY occurred_at DESC, created_at DESC
            LIMIT 1
          ) AS consent ON true
          WHERE decision.org_id = ${context.organizationId}
            AND decision.id = ${member.decisionId}
            AND decision.customer_id = ${member.customerId}
            AND decision.program_id = ${campaign.program_id}
        `;
        const decision = decisions[0];
        if (
          !decision ||
          decision.status !== "eligible" ||
          decision.invalidated_at ||
          decision.input_evidence_cutoff_at > evidenceCutoffAt
        ) {
          throw new RetentionServiceError(
            "recipient_decision_not_eligible",
            "Every audience member requires a current eligible AI decision.",
            409,
            { customerId: member.customerId },
          );
        }
        if (decision.consent_state !== "subscribed") {
          throw new RetentionServiceError(
            "recipient_not_subscribed",
            "Every frozen audience member must have current email consent.",
            409,
            { customerId: member.customerId },
          );
        }
        const sensitiveInferenceUsed =
          decision.sensitivity === "sensitive" ||
          decision.sensitivity === "restricted";
        if (sensitiveInferenceUsed) {
          sensitiveMemberCount += 1;
          if (
            settings[0]?.sensitive_targeting_enabled !== true ||
            !settings[0]?.lawful_basis_recorded_at
          ) {
            throw new RetentionServiceError(
              "sensitive_targeting_disabled",
              "Sensitive targeting requires an organization policy and recorded lawful basis.",
              403,
            );
          }
        }
        verifiedMembers.push({
          ...member,
          sensitiveInferenceUsed,
          consentState: decision.consent_state,
        });
      }

      if (campaign.existing_snapshot_id) {
        await tx`
          DELETE FROM retention_audience_snapshots
          WHERE org_id = ${context.organizationId}
            AND id = ${campaign.existing_snapshot_id}
        `;
      }
      await tx`
        DELETE FROM retention_rendered_messages
        WHERE org_id = ${context.organizationId}
          AND campaign_id = ${input.campaignId}
      `;
      await tx`
        UPDATE retention_budget_reservations
        SET status = 'released', updated_at = now()
        WHERE org_id = ${context.organizationId}
          AND campaign_id = ${input.campaignId}
          AND status = 'reserved'
      `;
      const audienceSnapshotId = randomUUID();
      await tx`
        INSERT INTO retention_audience_snapshots (
          id,
          org_id,
          campaign_id,
          definition_version,
          snapshot_sha256,
          member_count,
          sensitive_member_count,
          evidence_cutoff_at,
          frozen_by,
          frozen_at
        )
        VALUES (
          ${audienceSnapshotId},
          ${context.organizationId},
          ${input.campaignId},
          ${input.definitionVersion},
          ${snapshotSha256},
          ${verifiedMembers.length},
          ${sensitiveMemberCount},
          ${evidenceCutoffAt},
          ${context.userId},
          now()
        )
      `;
      for (const member of verifiedMembers) {
        await tx`
          INSERT INTO retention_audience_members (
            org_id,
            audience_snapshot_id,
            customer_id,
            decision_id,
            inclusion_explanation_ciphertext,
            sensitive_inference_used,
            consent_state
          )
          VALUES (
            ${context.organizationId},
            ${audienceSnapshotId},
            ${member.customerId},
            ${member.decisionId},
            ${this.crypto.encrypt(
              member.inclusionExplanation,
              `${context.organizationId}:audience:${audienceSnapshotId}:customer:${member.customerId}:explanation`,
            )},
            ${member.sensitiveInferenceUsed},
            ${member.consentState}
          )
        `;
      }
      await tx`
        UPDATE retention_approvals
        SET status = 'invalidated', invalidated_at = now()
        WHERE org_id = ${context.organizationId}
          AND campaign_id = ${input.campaignId}
          AND status = 'approved'
      `;
      await tx`
        UPDATE retention_campaigns
        SET
          revision = CASE
            WHEN ${campaign.existing_snapshot_id !== null}
              THEN revision + 1
            ELSE revision
          END,
          status = 'audience_frozen',
          approval_snapshot_sha256 = NULL,
          approved_at = NULL,
          approved_by = NULL,
          updated_at = now()
        WHERE org_id = ${context.organizationId}
          AND id = ${input.campaignId}
      `;
      await this.audit(tx, context, {
        action: "campaign.audience_frozen",
        resourceType: "campaign",
        resourceId: input.campaignId,
        metadata: {
          audienceSnapshotId,
          memberCount: verifiedMembers.length,
          sensitiveMemberCount,
          snapshotSha256,
        },
      });
      return {
        campaignId: input.campaignId,
        audienceSnapshotId,
        snapshotSha256,
        memberCount: verifiedMembers.length,
        sensitiveMemberCount,
        duplicate: false,
      };
    });
  }

  async prepareCampaignGeneration(
    context: TenantContext,
    input: {
      campaignId: string;
      strategy: unknown;
      strategyVersion: string;
      modelProvider: string;
      modelId: string;
      promptVersion: string;
      estimatedMaxCostUsd: number;
      campaignSpendCeilingUsd?: number;
    },
  ): Promise<{
    campaignId: string;
    status: "generating";
    budgetReservationId: string;
    estimatedMaxCostUsd: number;
  }> {
    assertUuid(input.campaignId, "campaignId");
    assertNonNegativeMoney(input.estimatedMaxCostUsd, "estimatedMaxCostUsd");
    if (input.campaignSpendCeilingUsd !== undefined) {
      assertNonNegativeMoney(
        input.campaignSpendCeilingUsd,
        "campaignSpendCeilingUsd",
      );
      if (input.estimatedMaxCostUsd > input.campaignSpendCeilingUsd) {
        throw new RetentionServiceError(
          "campaign_spend_ceiling_exceeded",
          "The estimated provider cost exceeds the campaign ceiling.",
          409,
        );
      }
    }
    return this.database.withTenant(context.organizationId, async (tx) => {
      const campaigns = await tx<
        Array<{ status: string; audience_id: string | null }>
      >`
        SELECT campaign.status, audience.id AS audience_id
        FROM retention_campaigns AS campaign
        LEFT JOIN retention_audience_snapshots AS audience
          ON audience.org_id = campaign.org_id
          AND audience.campaign_id = campaign.id
        WHERE campaign.org_id = ${context.organizationId}
          AND campaign.id = ${input.campaignId}
        FOR UPDATE OF campaign
      `;
      const campaign = campaigns[0];
      if (!campaign?.audience_id) {
        throw new RetentionServiceError(
          "campaign_not_ready",
          "Freeze the Worklin audience before generating content.",
          409,
        );
      }
      if (
        campaign.status !== "audience_frozen" &&
        campaign.status !== "generating"
      ) {
        throw new RetentionServiceError(
          "campaign_not_generatable",
          "The campaign cannot begin generation in its current state.",
          409,
        );
      }
      const settings = await tx<
        Array<{
          campaign_spend_limit_usd: string | null;
          monthly_spend_limit_usd: string | null;
        }>
      >`
        SELECT
          campaign_spend_limit_usd::TEXT,
          monthly_spend_limit_usd::TEXT
        FROM retention_org_settings
        WHERE org_id = ${context.organizationId}
      `;
      const campaignLimit = settings[0]?.campaign_spend_limit_usd
        ? Number(settings[0].campaign_spend_limit_usd)
        : null;
      if (campaignLimit !== null && input.estimatedMaxCostUsd > campaignLimit) {
        throw new RetentionServiceError(
          "organization_campaign_spend_limit_exceeded",
          "The estimated provider cost exceeds the workspace campaign limit.",
          409,
        );
      }
      const monthUsage = await tx<Array<{ used: string; reserved: string }>>`
        SELECT
          COALESCE((
            SELECT sum(estimated_cost_usd)
            FROM retention_usage_events
            WHERE org_id = ${context.organizationId}
              AND created_at >= date_trunc('month', now())
          ), 0)::TEXT AS used,
          COALESCE((
            SELECT sum(estimated_cost_usd)
            FROM retention_budget_reservations
            WHERE org_id = ${context.organizationId}
              AND status = 'reserved'
              AND expires_at > now()
              AND campaign_id <> ${input.campaignId}
          ), 0)::TEXT AS reserved
      `;
      const monthlyLimit = settings[0]?.monthly_spend_limit_usd
        ? Number(settings[0].monthly_spend_limit_usd)
        : null;
      const projectedMonthly =
        Number(monthUsage[0]?.used ?? 0) +
        Number(monthUsage[0]?.reserved ?? 0) +
        input.estimatedMaxCostUsd;
      if (monthlyLimit !== null && projectedMonthly > monthlyLimit) {
        throw new RetentionServiceError(
          "organization_monthly_spend_limit_exceeded",
          "The estimated provider cost exceeds the workspace monthly limit.",
          409,
        );
      }
      const existing = await tx<
        Array<{ id: string; estimated_cost_usd: string }>
      >`
        SELECT id, estimated_cost_usd::TEXT
        FROM retention_budget_reservations
        WHERE org_id = ${context.organizationId}
          AND campaign_id = ${input.campaignId}
          AND status = 'reserved'
        FOR UPDATE
      `;
      const budgetReservationId = existing[0]?.id ?? randomUUID();
      if (
        existing[0] &&
        Number(existing[0].estimated_cost_usd) !== input.estimatedMaxCostUsd
      ) {
        throw new RetentionServiceError(
          "budget_reservation_conflict",
          "This campaign already has a different active budget reservation.",
          409,
        );
      }
      if (!existing[0]) {
        await tx`
          INSERT INTO retention_budget_reservations (
            id,
            org_id,
            campaign_id,
            status,
            estimated_cost_usd,
            reserved_by,
            reserved_at,
            expires_at
          )
          VALUES (
            ${budgetReservationId},
            ${context.organizationId},
            ${input.campaignId},
            'reserved',
            ${input.estimatedMaxCostUsd},
            ${context.userId},
            now(),
            now() + interval '24 hours'
          )
        `;
      }
      await tx`
        UPDATE retention_campaigns
        SET
          status = 'generating',
          strategy_ciphertext = ${encryptedJson(
            this.crypto,
            input.strategy,
            `${context.organizationId}:campaign:${input.campaignId}:strategy`,
          )},
          strategy_version = ${input.strategyVersion},
          model_provider = ${input.modelProvider},
          model_id = ${input.modelId},
          prompt_version = ${input.promptVersion},
          approval_snapshot_sha256 = NULL,
          approved_at = NULL,
          approved_by = NULL,
          updated_at = now()
        WHERE org_id = ${context.organizationId}
          AND id = ${input.campaignId}
      `;
      await this.audit(tx, context, {
        action: "campaign.generation_started",
        resourceType: "campaign",
        resourceId: input.campaignId,
        metadata: {
          budgetReservationId,
          estimatedMaxCostUsd: input.estimatedMaxCostUsd,
        },
      });
      return {
        campaignId: input.campaignId,
        status: "generating",
        budgetReservationId,
        estimatedMaxCostUsd: input.estimatedMaxCostUsd,
      };
    });
  }

  async recordRenderedMessage(
    context: TenantContext,
    input: {
      campaignId: string;
      customerId: string;
      subject: string;
      preheader?: string;
      body: string;
      offer?: string;
      explanation: string;
      modelProvider: string;
      modelId: string;
      promptVersion: string;
      generatedAt: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        estimatedCostUsd?: number;
      };
    },
  ): Promise<{
    campaignId: string;
    messageId: string;
    messageSha256: string;
    campaignStatus: "generating" | "review_required";
    qualityStatus: "passed" | "needs_review" | "blocked";
    qualityIssueCodes: string[];
  }> {
    assertUuid(input.campaignId, "campaignId");
    assertUuid(input.customerId, "customerId");
    if (input.usage.estimatedCostUsd !== undefined) {
      assertNonNegativeMoney(input.usage.estimatedCostUsd, "estimatedCostUsd");
    }
    const generatedAt = new Date(input.generatedAt);
    if (Number.isNaN(generatedAt.valueOf())) {
      throw new RetentionServiceError(
        "invalid_message_timestamp",
        "The message generation time must be a valid ISO date.",
        400,
      );
    }
    const messageSha256 = sha256(
      canonicalJson({
        customerId: input.customerId,
        subject: input.subject,
        preheader: input.preheader ?? null,
        body: input.body,
        offer: input.offer ?? null,
        explanation: input.explanation,
        modelProvider: input.modelProvider,
        modelId: input.modelId,
        promptVersion: input.promptVersion,
      }),
    );
    return this.database.withTenant(context.organizationId, async (tx) => {
      const eligible = await tx<
        Array<{
          status: string;
          strategy_ciphertext: string | null;
          sensitive_inference_used: boolean;
        }>
      >`
        SELECT
          campaign.status,
          campaign.strategy_ciphertext,
          member.sensitive_inference_used
        FROM retention_campaigns AS campaign
        JOIN retention_audience_snapshots AS audience
          ON audience.org_id = campaign.org_id
          AND audience.campaign_id = campaign.id
        JOIN retention_audience_members AS member
          ON member.org_id = audience.org_id
          AND member.audience_snapshot_id = audience.id
        WHERE campaign.org_id = ${context.organizationId}
          AND campaign.id = ${input.campaignId}
          AND member.customer_id = ${input.customerId}
        FOR UPDATE OF campaign
      `;
      if (!eligible[0] || eligible[0].status !== "generating") {
        throw new RetentionServiceError(
          "campaign_not_generating",
          "The recipient is not part of a campaign currently generating.",
          409,
        );
      }
      if (!eligible[0].strategy_ciphertext) {
        throw new RetentionServiceError(
          "campaign_strategy_missing",
          "The frozen campaign strategy is missing.",
          409,
        );
      }
      const sensitiveTraits = eligible[0].sensitive_inference_used
        ? await tx<
            Array<{
              id: string;
              trait_key: string;
              value_ciphertext: string;
            }>
          >`
            SELECT id, trait_key, value_ciphertext
            FROM retention_customer_traits
            WHERE org_id = ${context.organizationId}
              AND customer_id = ${input.customerId}
              AND sensitivity IN ('sensitive', 'restricted')
              AND targeting_status = 'approved'
              AND (expires_at IS NULL OR expires_at > now())
            ORDER BY observed_at DESC, id
            LIMIT 100
          `
        : [];
      const quality = validateMessageQuality({
        content: {
          subject: input.subject,
          preheader: input.preheader,
          body: input.body,
          offer: input.offer,
        },
        evidence: buildMessageQualityEvidence({
          frozenStrategy: JSON.parse(
            this.crypto.decrypt(
              eligible[0].strategy_ciphertext,
              `${context.organizationId}:campaign:${input.campaignId}:strategy`,
            ),
          ),
          sensitiveTraits: sensitiveTraits.map((trait) => ({
            id: trait.id,
            key: trait.trait_key,
            value: JSON.parse(
              this.crypto.decrypt(
                trait.value_ciphertext,
                `${context.organizationId}:trait:${trait.id}:value`,
              ),
            ),
          })),
        }),
      });
      const qualityStatus = quality.valid
        ? quality.warnings.length > 0
          ? "needs_review"
          : "passed"
        : "blocked";
      const qualityIssueCodes = [
        ...new Set(
          [...quality.blockingErrors, ...quality.warnings].map(
            (issue) => issue.code,
          ),
        ),
      ];
      const sensitiveContentBlocked = quality.blockingErrors.some(
        (issue) =>
          issue.code === "sensitive_trait_revelation" ||
          issue.code === "sensitive_trait_implication",
      );
      const existing = await tx<Array<{ id: string }>>`
        SELECT id
        FROM retention_rendered_messages
        WHERE org_id = ${context.organizationId}
          AND campaign_id = ${input.campaignId}
          AND customer_id = ${input.customerId}
        FOR UPDATE
      `;
      const messageId = existing[0]?.id ?? randomUUID();
      await tx`
        INSERT INTO retention_rendered_messages (
          id,
          org_id,
          campaign_id,
          customer_id,
          subject_ciphertext,
          preheader_ciphertext,
          body_ciphertext,
          offer_ciphertext,
          explanation_ciphertext,
          message_sha256,
          model_provider,
          model_id,
          prompt_version,
          quality_status,
          sensitive_content_blocked,
          generated_at
        )
        VALUES (
          ${messageId},
          ${context.organizationId},
          ${input.campaignId},
          ${input.customerId},
          ${this.crypto.encrypt(
            input.subject,
            `${context.organizationId}:message:${messageId}:subject`,
          )},
          ${
            input.preheader
              ? this.crypto.encrypt(
                  input.preheader,
                  `${context.organizationId}:message:${messageId}:preheader`,
                )
              : null
          },
          ${this.crypto.encrypt(
            input.body,
            `${context.organizationId}:message:${messageId}:body`,
          )},
          ${
            input.offer
              ? this.crypto.encrypt(
                  input.offer,
                  `${context.organizationId}:message:${messageId}:offer`,
                )
              : null
          },
          ${this.crypto.encrypt(
            input.explanation,
            `${context.organizationId}:message:${messageId}:explanation`,
          )},
          ${messageSha256},
          ${input.modelProvider},
          ${input.modelId},
          ${input.promptVersion},
          ${qualityStatus},
          ${sensitiveContentBlocked},
          ${generatedAt}
        )
        ON CONFLICT (org_id, campaign_id, customer_id)
        DO UPDATE SET
          subject_ciphertext = EXCLUDED.subject_ciphertext,
          preheader_ciphertext = EXCLUDED.preheader_ciphertext,
          body_ciphertext = EXCLUDED.body_ciphertext,
          offer_ciphertext = EXCLUDED.offer_ciphertext,
          explanation_ciphertext = EXCLUDED.explanation_ciphertext,
          message_sha256 = EXCLUDED.message_sha256,
          model_provider = EXCLUDED.model_provider,
          model_id = EXCLUDED.model_id,
          prompt_version = EXCLUDED.prompt_version,
          quality_status = EXCLUDED.quality_status,
          sensitive_content_blocked = EXCLUDED.sensitive_content_blocked,
          generated_at = EXCLUDED.generated_at,
          updated_at = now()
      `;
      await tx`
        INSERT INTO retention_usage_events (
          id,
          org_id,
          campaign_id,
          customer_id,
          purpose,
          provider,
          model,
          input_tokens,
          output_tokens,
          cache_read_tokens,
          cache_write_tokens,
          estimated_cost_usd
        )
        VALUES (
          ${randomUUID()},
          ${context.organizationId},
          ${input.campaignId},
          ${input.customerId},
          'recipient_message',
          ${input.modelProvider},
          ${input.modelId},
          ${input.usage.inputTokens},
          ${input.usage.outputTokens},
          ${input.usage.cacheReadTokens ?? 0},
          ${input.usage.cacheWriteTokens ?? 0},
          ${input.usage.estimatedCostUsd ?? null}
        )
      `;
      const coverage = await tx<
        Array<{ members: string; ready_messages: string }>
      >`
        SELECT
          count(*)::TEXT AS members,
          count(message.id) FILTER (
            WHERE message.quality_status IN ('passed', 'needs_review')
              AND message.sensitive_content_blocked = false
          )::TEXT AS ready_messages
        FROM retention_audience_snapshots AS audience
        JOIN retention_audience_members AS member
          ON member.org_id = audience.org_id
          AND member.audience_snapshot_id = audience.id
        LEFT JOIN retention_rendered_messages AS message
          ON message.org_id = member.org_id
          AND message.campaign_id = audience.campaign_id
          AND message.customer_id = member.customer_id
        WHERE audience.org_id = ${context.organizationId}
          AND audience.campaign_id = ${input.campaignId}
      `;
      const complete =
        Number(coverage[0]?.members ?? 0) > 0 &&
        Number(coverage[0]?.members ?? 0) ===
          Number(coverage[0]?.ready_messages ?? 0);
      const campaignStatus = complete ? "review_required" : "generating";
      await tx`
        UPDATE retention_campaigns
        SET status = ${campaignStatus}, updated_at = now()
        WHERE org_id = ${context.organizationId}
          AND id = ${input.campaignId}
      `;
      await this.audit(tx, context, {
        action: "campaign.message_recorded",
        resourceType: "campaign",
        resourceId: input.campaignId,
        metadata: {
          messageId,
          customerId: input.customerId,
          qualityStatus,
          qualityIssueCodes,
          sensitiveContentBlocked,
          campaignStatus,
        },
      });
      return {
        campaignId: input.campaignId,
        messageId,
        messageSha256,
        campaignStatus,
        qualityStatus,
        qualityIssueCodes,
      };
    });
  }

  async approveCampaign(
    context: TenantContext,
    input: {
      campaignId: string;
      brandId: string;
      expectedSnapshotSha256?: string;
      note?: string;
    },
  ): Promise<{
    campaignId: string;
    status: "approved";
    snapshotSha256: string;
  }> {
    assertUuid(input.campaignId, "campaignId");
    if (!context.permissions.includes("retention:approve")) {
      throw new RetentionServiceError(
        "approval_permission_required",
        "A named retention campaign approver is required.",
        403,
      );
    }
    return this.database.withTenant(context.organizationId, async (tx) => {
      const campaigns = await tx<
        Array<{
          status: string;
          approval_snapshot_sha256: string | null;
        }>
      >`
        SELECT status, approval_snapshot_sha256
        FROM retention_campaigns
        WHERE org_id = ${context.organizationId}
          AND id = ${input.campaignId}
          AND brand_id = ${input.brandId}
        FOR UPDATE
      `;
      const campaign = campaigns[0];
      if (!campaign) {
        throw new RetentionServiceError(
          "campaign_not_found",
          "The retention campaign was not found.",
          404,
        );
      }
      if (
        campaign.status !== "review_required" &&
        campaign.status !== "approved"
      ) {
        throw new RetentionServiceError(
          "campaign_not_reviewable",
          "The campaign is not ready for approval.",
          409,
        );
      }
      if (
        campaign.approval_snapshot_sha256 &&
        input.expectedSnapshotSha256 &&
        campaign.approval_snapshot_sha256 !== input.expectedSnapshotSha256
      ) {
        throw new RetentionServiceError(
          "approval_invalidated",
          "The campaign changed after the approval snapshot was created.",
          409,
        );
      }
      const material = await this.currentApprovalMaterial(
        tx,
        context.organizationId,
        input.campaignId,
        input.brandId,
      );
      const checksum = getCampaignApprovalChecksum(material);
      if (!checksum.ok) {
        throw new RetentionServiceError(
          checksum.error.code,
          checksum.error.message,
          409,
          checksum.error.details ? { ...checksum.error.details } : undefined,
        );
      }
      if (
        input.expectedSnapshotSha256 &&
        input.expectedSnapshotSha256 !== checksum.value
      ) {
        throw new RetentionServiceError(
          "approval_invalidated",
          "The campaign changed before approval.",
          409,
        );
      }
      const approvalId = randomUUID();
      await tx`
        UPDATE retention_approvals
        SET
          status = 'invalidated',
          invalidated_at = now()
        WHERE org_id = ${context.organizationId}
          AND campaign_id = ${input.campaignId}
          AND status = 'approved'
      `;
      await tx`
        INSERT INTO retention_approvals (
          id,
          org_id,
          campaign_id,
          approval_type,
          snapshot_sha256,
          status,
          requested_by,
          decided_by,
          requested_at,
          decided_at,
          decision_note_ciphertext,
          material_ciphertext
        )
        VALUES (
          ${approvalId},
          ${context.organizationId},
          ${input.campaignId},
          'campaign',
          ${checksum.value},
          'approved',
          ${context.userId},
          ${context.userId},
          now(),
          now(),
          ${
            input.note
              ? this.crypto.encrypt(
                  input.note,
                  `${context.organizationId}:approval:${approvalId}:note`,
                )
              : null
          },
          ${this.crypto.encrypt(
            canonicalJson(material),
            `${context.organizationId}:approval:${approvalId}:material`,
          )}
        )
      `;
      await tx`
        UPDATE retention_campaigns
        SET
          status = 'approved',
          approval_snapshot_sha256 = ${checksum.value},
          approved_by = ${context.userId},
          approved_at = now(),
          updated_at = now()
        WHERE org_id = ${context.organizationId}
          AND id = ${input.campaignId}
      `;
      await this.audit(tx, context, {
        action: "campaign.approved",
        resourceType: "campaign",
        resourceId: input.campaignId,
        metadata: { snapshotSha256: checksum.value },
      });
      return {
        campaignId: input.campaignId,
        status: "approved",
        snapshotSha256: checksum.value,
      };
    });
  }

  async releaseCampaign(
    context: TenantContext,
    input: {
      campaignId: string;
      brandId: string;
      idempotencyKey: string;
      snapshotSha256: string;
    },
  ): Promise<{
    dispatchId: string;
    status:
      | "pending"
      | "sending"
      | "sent"
      | "partially_sent"
      | "failed"
      | "cancelled";
    duplicate: boolean;
  }> {
    assertUuid(input.campaignId, "campaignId");
    if (!context.permissions.includes("retention:send")) {
      throw new RetentionServiceError(
        "send_permission_required",
        "A named retention campaign sender is required.",
        403,
      );
    }
    if (!this.options.externalWritesEnabled || !this.options.sendEnabled) {
      throw new RetentionServiceError(
        "external_sending_disabled",
        "Retention sending is disabled for this deployment.",
        503,
      );
    }
    return this.database.withTenant(context.organizationId, async (tx) => {
      const settings = await tx<
        Array<{
          external_writes_enabled: boolean;
          send_enabled: boolean;
        }>
      >`
        SELECT external_writes_enabled, send_enabled
        FROM retention_org_settings
        WHERE org_id = ${context.organizationId}
      `;
      if (
        settings[0]?.external_writes_enabled !== true ||
        settings[0]?.send_enabled !== true
      ) {
        throw new RetentionServiceError(
          "organization_sending_disabled",
          "Retention sending is disabled for this workspace.",
          403,
        );
      }
      const existing = await tx<
        Array<{
          id: string;
          status:
            | "pending"
            | "sending"
            | "sent"
            | "partially_sent"
            | "failed"
            | "cancelled";
          campaign_id: string;
          approval_snapshot_sha256: string;
        }>
      >`
        SELECT id, status, campaign_id, approval_snapshot_sha256
        FROM retention_dispatches
        WHERE org_id = ${context.organizationId}
          AND idempotency_key = ${input.idempotencyKey}
      `;
      if (existing[0]) {
        if (
          existing[0].campaign_id !== input.campaignId ||
          existing[0].approval_snapshot_sha256 !== input.snapshotSha256
        ) {
          throw new RetentionServiceError(
            "idempotency_conflict",
            "That send request key was already used for different campaign content.",
            409,
          );
        }
        return {
          dispatchId: existing[0].id,
          status: existing[0].status,
          duplicate: true,
        };
      }
      const campaigns = await tx<
        Array<{
          status: string;
          approval_snapshot_sha256: string | null;
          member_count: string | null;
        }>
      >`
        SELECT
          campaign.status,
          campaign.approval_snapshot_sha256,
          audience.member_count::TEXT
        FROM retention_campaigns AS campaign
        LEFT JOIN retention_audience_snapshots AS audience
          ON audience.org_id = campaign.org_id
          AND audience.campaign_id = campaign.id
        WHERE campaign.org_id = ${context.organizationId}
          AND campaign.id = ${input.campaignId}
          AND campaign.brand_id = ${input.brandId}
        FOR UPDATE OF campaign
      `;
      const campaign = campaigns[0];
      if (!campaign) {
        throw new RetentionServiceError(
          "campaign_not_found",
          "The retention campaign was not found.",
          404,
        );
      }
      if (
        campaign.status !== "approved" ||
        campaign.approval_snapshot_sha256 !== input.snapshotSha256
      ) {
        throw new RetentionServiceError(
          "approval_invalidated",
          "The campaign does not have a current approval.",
          409,
        );
      }
      const material = await this.currentApprovalMaterial(
        tx,
        context.organizationId,
        input.campaignId,
        input.brandId,
      );
      const currentChecksum = getCampaignApprovalChecksum(material);
      if (
        !currentChecksum.ok ||
        currentChecksum.value !== input.snapshotSha256
      ) {
        await tx`
          UPDATE retention_approvals
          SET status = 'invalidated', invalidated_at = now()
          WHERE org_id = ${context.organizationId}
            AND campaign_id = ${input.campaignId}
            AND status = 'approved'
        `;
        await tx`
          UPDATE retention_campaigns
          SET
            status = 'review_required',
            approval_snapshot_sha256 = NULL,
            approved_by = NULL,
            approved_at = NULL,
            updated_at = now()
          WHERE org_id = ${context.organizationId}
            AND id = ${input.campaignId}
        `;
        throw new RetentionServiceError(
          "approval_invalidated",
          "The campaign changed after approval and must be reviewed again.",
          409,
        );
      }
      const dispatchId = randomUUID();
      const inserted = await tx<Array<{ id: string }>>`
        INSERT INTO retention_dispatches (
          id,
          org_id,
          campaign_id,
          provider,
          idempotency_key,
          approval_snapshot_sha256,
          status,
          recipient_count,
          released_by,
          released_at
        )
        VALUES (
          ${dispatchId},
          ${context.organizationId},
          ${input.campaignId},
          'klaviyo',
          ${input.idempotencyKey},
          ${input.snapshotSha256},
          'pending',
          ${Number(campaign.member_count ?? 0)},
          ${context.userId},
          now()
        )
        ON CONFLICT (org_id, idempotency_key) DO NOTHING
        RETURNING id
      `;
      if (inserted.length === 0) {
        throw new RetentionServiceError(
          "idempotency_conflict",
          "The send request is already being processed.",
          409,
        );
      }
      await this.createDispatchRecipients(
        tx,
        context.organizationId,
        input.campaignId,
        dispatchId,
      );
      await tx`
        UPDATE retention_campaigns
        SET
          status = 'ready_to_send',
          released_by = ${context.userId},
          released_at = now(),
          updated_at = now()
        WHERE org_id = ${context.organizationId}
          AND id = ${input.campaignId}
      `;
      await this.enqueueJob(tx, context.organizationId, {
        id: randomUUID(),
        type: "dispatch_campaign",
        dedupeKey: dispatchId,
        payload: { campaignId: input.campaignId, dispatchId },
      });
      await this.audit(tx, context, {
        action: "campaign.released",
        resourceType: "campaign",
        resourceId: input.campaignId,
        metadata: { dispatchId },
      });
      return { dispatchId, status: "pending", duplicate: false };
    });
  }

  async reviewImports(
    context: TenantContext,
    input: {
      brandId: string;
      integrationId?: string;
      status?: string;
      limit: number;
    },
  ): Promise<{
    imports: Array<{
      id: string;
      brandId: string;
      integrationId: string;
      provider: string;
      status: string;
      importedCount: number;
      rejectedCount: number;
      approvedAt: string | null;
      startedAt: string | null;
      completedAt: string | null;
      lastErrorCode: string | null;
      updatedAt: string;
      hasCheckpoint: boolean;
    }>;
  }> {
    assertUuid(input.brandId, "brandId");
    if (input.integrationId) {
      assertUuid(input.integrationId, "integrationId");
    }
    return this.database.withTenant(context.organizationId, async (tx) => {
      const rows = await tx<
        Array<{
          id: string;
          brand_id: string;
          integration_id: string;
          provider: string;
          status: string;
          imported_count: string;
          rejected_count: string;
          approved_at: Date | null;
          started_at: Date | null;
          completed_at: Date | null;
          last_error_code: string | null;
          updated_at: Date;
          has_checkpoint: boolean;
        }>
      >`
        SELECT
          migration.id,
          integration.brand_id,
          migration.integration_id,
          integration.provider,
          migration.status,
          migration.imported_count::TEXT,
          migration.rejected_count::TEXT,
          migration.approved_at,
          migration.started_at,
          migration.completed_at,
          migration.last_error_code,
          migration.updated_at,
          migration.checkpoint <> '{}'::JSONB AS has_checkpoint
        FROM retention_migration_runs AS migration
        JOIN retention_integrations AS integration
          ON integration.org_id = migration.org_id
          AND integration.id = migration.integration_id
        WHERE migration.org_id = ${context.organizationId}
          AND integration.brand_id = ${input.brandId}
          AND (
            ${input.integrationId ?? null}::UUID IS NULL
            OR migration.integration_id = ${input.integrationId ?? null}
          )
          AND (
            ${input.status ?? null}::TEXT IS NULL
            OR migration.status = ${input.status ?? null}
          )
        ORDER BY migration.updated_at DESC, migration.id
        LIMIT ${input.limit}
      `;
      await this.audit(tx, context, {
        action: "imports.reviewed",
        resourceType: "migration_run",
        metadata: {
          brandId: input.brandId ?? null,
          integrationId: input.integrationId ?? null,
          status: input.status ?? null,
          resultCount: rows.length,
        },
      });
      return {
        imports: rows.map((row) => ({
          id: row.id,
          brandId: row.brand_id,
          integrationId: row.integration_id,
          provider: row.provider,
          status: row.status,
          importedCount: Number(row.imported_count),
          rejectedCount: Number(row.rejected_count),
          approvedAt: row.approved_at?.toISOString() ?? null,
          startedAt: row.started_at?.toISOString() ?? null,
          completedAt: row.completed_at?.toISOString() ?? null,
          lastErrorCode: row.last_error_code,
          updatedAt: row.updated_at.toISOString(),
          hasCheckpoint: row.has_checkpoint,
        })),
      };
    });
  }

  async explainCustomer(
    context: TenantContext,
    input: {
      customerId: string;
      programId?: string;
      campaignId?: string;
    },
  ): Promise<{
    customerReference: string;
    currentDecision: {
      decisionReference: string;
      programId: string;
      programName: string;
      programType: string;
      status: string;
      objective: string | null;
      rationale: string | null;
      rationaleRedacted: boolean;
      confidence: number | null;
      evidenceCount: number;
      reasonedAt: string | null;
    } | null;
    movement: {
      from: string;
      to: string;
      changedAt: string | null;
    } | null;
    decisionHistory: Array<{
      decisionReference: string;
      programId: string;
      programName: string;
      programType: string;
      status: string;
      objective: string | null;
      rationale: string | null;
      rationaleRedacted: boolean;
      confidence: number | null;
      evidenceCount: number;
      reasonedAt: string | null;
    }>;
    campaignMemberships: Array<{
      campaignId: string;
      campaignName: string;
      campaignStatus: string;
      inclusionExplanation: string;
      explanationRedacted: boolean;
      frozenAt: string;
    }>;
  }> {
    assertUuid(input.customerId, "customerId");
    if (input.programId) assertUuid(input.programId, "programId");
    if (input.campaignId) assertUuid(input.campaignId, "campaignId");
    return this.database.withTenant(context.organizationId, async (tx) => {
      const customers = await tx<
        Array<{
          primary_email_ciphertext: string | null;
          primary_phone_ciphertext: string | null;
          display_name_ciphertext: string | null;
        }>
      >`
        SELECT
          primary_email_ciphertext,
          primary_phone_ciphertext,
          display_name_ciphertext
        FROM retention_customers
        WHERE org_id = ${context.organizationId}
          AND id = ${input.customerId}
          AND status <> 'deleted'
      `;
      const customer = customers[0];
      if (!customer) {
        throw new RetentionServiceError(
          "customer_not_found",
          "The retention customer was not found.",
          404,
        );
      }
      const identifiers = [
        customer.primary_email_ciphertext
          ? this.crypto.decrypt(
              customer.primary_email_ciphertext,
              `${context.organizationId}:customer:${input.customerId}:email`,
            )
          : null,
        customer.primary_phone_ciphertext
          ? this.crypto.decrypt(
              customer.primary_phone_ciphertext,
              `${context.organizationId}:customer:${input.customerId}:phone`,
            )
          : null,
        this.decryptCustomerDisplayName(
          context.organizationId,
          input.customerId,
          customer.display_name_ciphertext,
        ),
      ].filter((value): value is string => value !== null);
      const decisions = await tx<
        Array<{
          id: string;
          program_id: string;
          program_name: string;
          program_type: string;
          status: string;
          objective: string | null;
          reasoning_ciphertext: string | null;
          sensitivity: string;
          confidence: string | null;
          evidence_count: string;
          reasoned_at: Date | null;
          approved_sensitive_use: boolean;
        }>
      >`
        SELECT
          decision.id,
          decision.program_id,
          program.name AS program_name,
          program.program_type,
          decision.status,
          decision.objective,
          decision.reasoning_ciphertext,
          decision.sensitivity,
          decision.confidence::TEXT,
          cardinality(decision.evidence_event_ids)::TEXT AS evidence_count,
          decision.reasoned_at,
          EXISTS (
            SELECT 1
            FROM retention_audience_members AS member
            JOIN retention_audience_snapshots AS audience
              ON audience.org_id = member.org_id
              AND audience.id = member.audience_snapshot_id
            JOIN retention_approvals AS approval
              ON approval.org_id = audience.org_id
              AND approval.campaign_id = audience.campaign_id
              AND approval.status = 'approved'
            WHERE member.org_id = decision.org_id
              AND member.decision_id = decision.id
          ) AS approved_sensitive_use
        FROM retention_customer_decisions AS decision
        JOIN retention_programs AS program
          ON program.org_id = decision.org_id
          AND program.id = decision.program_id
        WHERE decision.org_id = ${context.organizationId}
          AND decision.customer_id = ${input.customerId}
          AND (
            ${input.programId ?? null}::UUID IS NULL
            OR decision.program_id = ${input.programId ?? null}
          )
          AND (
            ${input.campaignId ?? null}::UUID IS NULL
            OR EXISTS (
              SELECT 1
              FROM retention_audience_members AS member
              JOIN retention_audience_snapshots AS audience
                ON audience.org_id = member.org_id
                AND audience.id = member.audience_snapshot_id
              WHERE member.org_id = decision.org_id
                AND member.decision_id = decision.id
                AND audience.campaign_id = ${input.campaignId ?? null}
            )
          )
        ORDER BY
          decision.reasoned_at DESC NULLS LAST,
          decision.created_at DESC,
          decision.id
        LIMIT 25
      `;
      const decisionHistory = decisions.map((decision) => {
        let rationale = "";
        if (decision.reasoning_ciphertext) {
          const parsed = JSON.parse(
            this.crypto.decrypt(
              decision.reasoning_ciphertext,
              `${context.organizationId}:decision:${decision.id}:reasoning`,
            ),
          ) as { rationale?: unknown };
          rationale =
            typeof parsed.rationale === "string" ? parsed.rationale : "";
        }
        const operatorRationale = rationale
          ? operatorDecisionRationale({
              rationale,
              identifiers,
              sensitivity: decision.sensitivity,
              approvedSensitiveUse: decision.approved_sensitive_use,
            })
          : { summary: "", redacted: false };
        return {
          decisionReference: `decision_${sha256(decision.id).slice(0, 12)}`,
          programId: decision.program_id,
          programName: decision.program_name,
          programType: decision.program_type,
          status: decision.status,
          objective: decision.objective
            ? redactOperatorText(decision.objective, identifiers)
            : null,
          rationale: operatorRationale.summary || null,
          rationaleRedacted: operatorRationale.redacted,
          confidence:
            decision.confidence === null ? null : Number(decision.confidence),
          evidenceCount: Number(decision.evidence_count),
          reasonedAt: decision.reasoned_at?.toISOString() ?? null,
        };
      });
      const memberships = await tx<
        Array<{
          campaign_id: string;
          campaign_name: string;
          campaign_status: string;
          audience_snapshot_id: string;
          decision_id: string;
          inclusion_explanation_ciphertext: string;
          sensitive_inference_used: boolean;
          approved_sensitive_use: boolean;
          frozen_at: Date;
        }>
      >`
        SELECT
          campaign.id AS campaign_id,
          campaign.name AS campaign_name,
          campaign.status AS campaign_status,
          audience.id AS audience_snapshot_id,
          member.decision_id,
          member.inclusion_explanation_ciphertext,
          member.sensitive_inference_used,
          EXISTS (
            SELECT 1
            FROM retention_approvals AS approval
            WHERE approval.org_id = campaign.org_id
              AND approval.campaign_id = campaign.id
              AND approval.status = 'approved'
          ) AS approved_sensitive_use,
          audience.frozen_at
        FROM retention_audience_members AS member
        JOIN retention_audience_snapshots AS audience
          ON audience.org_id = member.org_id
          AND audience.id = member.audience_snapshot_id
        JOIN retention_campaigns AS campaign
          ON campaign.org_id = audience.org_id
          AND campaign.id = audience.campaign_id
        WHERE member.org_id = ${context.organizationId}
          AND member.customer_id = ${input.customerId}
          AND (
            ${input.campaignId ?? null}::UUID IS NULL
            OR campaign.id = ${input.campaignId ?? null}
          )
        ORDER BY audience.frozen_at DESC, campaign.id
      `;
      const campaignMemberships = memberships.map((membership) => {
        if (membership.sensitive_inference_used) {
          return {
            campaignId: membership.campaign_id,
            campaignName: membership.campaign_name,
            campaignStatus: membership.campaign_status,
            inclusionExplanation: membership.approved_sensitive_use
              ? "Human-approved sensitive evidence contributed to inclusion. The underlying trait and evidence are withheld."
              : "Sensitive evidence may have contributed to inclusion. Details are withheld pending explicit approval.",
            explanationRedacted: true,
            frozenAt: membership.frozen_at.toISOString(),
          };
        }
        return {
          campaignId: membership.campaign_id,
          campaignName: membership.campaign_name,
          campaignStatus: membership.campaign_status,
          inclusionExplanation: redactOperatorText(
            this.crypto.decrypt(
              membership.inclusion_explanation_ciphertext,
              `${context.organizationId}:audience:${membership.audience_snapshot_id}:customer:${input.customerId}:explanation`,
            ),
            identifiers,
          ),
          explanationRedacted: false,
          frozenAt: membership.frozen_at.toISOString(),
        };
      });
      const currentDecision = decisionHistory[0] ?? null;
      const previousDecision = decisionHistory[1] ?? null;
      await this.audit(tx, context, {
        action: "customer.explanation_viewed",
        resourceType: "customer",
        resourceId: input.customerId,
        metadata: {
          programId: input.programId ?? null,
          campaignId: input.campaignId ?? null,
        },
      });
      return {
        customerReference: operatorCustomerReference(
          context.organizationId,
          input.customerId,
        ),
        currentDecision,
        movement:
          currentDecision &&
          previousDecision &&
          currentDecision.status !== previousDecision.status
            ? {
                from: previousDecision.status,
                to: currentDecision.status,
                changedAt: currentDecision.reasonedAt,
              }
            : null,
        decisionHistory,
        campaignMemberships,
      };
    });
  }

  async listCampaigns(
    context: TenantContext,
    input: {
      brandId: string;
      status?: string;
      limit: number;
    },
  ): Promise<{
    campaigns: Array<{
      id: string;
      brandId: string;
      programId: string;
      programName: string;
      programType: string;
      name: string;
      mode: RetentionCampaignMode;
      status: string;
      revision: number;
      audienceMemberCount: number;
      sensitiveMemberCount: number;
      renderedMessageCount: number;
      dispatchStatus: string | null;
      acceptedCount: number;
      failedCount: number;
      estimatedCostUsd: number;
      updatedAt: string;
    }>;
  }> {
    assertUuid(input.brandId, "brandId");
    return this.database.withTenant(context.organizationId, async (tx) => {
      const rows = await tx<
        Array<{
          id: string;
          brand_id: string;
          program_id: string;
          program_name: string;
          program_type: string;
          name: string;
          mode: RetentionCampaignMode;
          status: string;
          revision: number;
          member_count: string;
          sensitive_member_count: string;
          message_count: string;
          dispatch_status: string | null;
          accepted_count: string;
          failed_count: string;
          estimated_cost_usd: string;
          updated_at: Date;
        }>
      >`
        SELECT
          campaign.id,
          campaign.brand_id,
          campaign.program_id,
          program.name AS program_name,
          program.program_type,
          campaign.name,
          campaign.mode,
          campaign.status,
          campaign.revision,
          COALESCE(audience.member_count, 0)::TEXT AS member_count,
          COALESCE(audience.sensitive_member_count, 0)::TEXT
            AS sensitive_member_count,
          COALESCE(messages.message_count, 0)::TEXT AS message_count,
          dispatch.status AS dispatch_status,
          COALESCE(dispatch.accepted_count, 0)::TEXT AS accepted_count,
          COALESCE(dispatch.failed_count, 0)::TEXT AS failed_count,
          COALESCE(usage.estimated_cost_usd, 0)::TEXT
            AS estimated_cost_usd,
          campaign.updated_at
        FROM retention_campaigns AS campaign
        JOIN retention_programs AS program
          ON program.org_id = campaign.org_id
          AND program.id = campaign.program_id
        LEFT JOIN retention_audience_snapshots AS audience
          ON audience.org_id = campaign.org_id
          AND audience.campaign_id = campaign.id
        LEFT JOIN LATERAL (
          SELECT count(*) AS message_count
          FROM retention_rendered_messages
          WHERE org_id = campaign.org_id
            AND campaign_id = campaign.id
        ) AS messages ON true
        LEFT JOIN LATERAL (
          SELECT status, accepted_count, failed_count
          FROM retention_dispatches
          WHERE org_id = campaign.org_id
            AND campaign_id = campaign.id
          ORDER BY created_at DESC, id
          LIMIT 1
        ) AS dispatch ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(sum(estimated_cost_usd), 0)
            AS estimated_cost_usd
          FROM retention_usage_events
          WHERE org_id = campaign.org_id
            AND campaign_id = campaign.id
        ) AS usage ON true
        WHERE campaign.org_id = ${context.organizationId}
          AND campaign.brand_id = ${input.brandId}
          AND (
            ${input.status ?? null}::TEXT IS NULL
            OR campaign.status = ${input.status ?? null}
          )
        ORDER BY campaign.updated_at DESC, campaign.id
        LIMIT ${input.limit}
      `;
      await this.audit(tx, context, {
        action: "campaigns.listed",
        resourceType: "campaign",
        metadata: {
          brandId: input.brandId,
          status: input.status ?? null,
          resultCount: rows.length,
        },
      });
      return {
        campaigns: rows.map((row) => ({
          id: row.id,
          brandId: row.brand_id,
          programId: row.program_id,
          programName: row.program_name,
          programType: row.program_type,
          name: row.name,
          mode: row.mode,
          status: row.status,
          revision: row.revision,
          audienceMemberCount: Number(row.member_count),
          sensitiveMemberCount: Number(row.sensitive_member_count),
          renderedMessageCount: Number(row.message_count),
          dispatchStatus: row.dispatch_status,
          acceptedCount: Number(row.accepted_count),
          failedCount: Number(row.failed_count),
          estimatedCostUsd: Number(row.estimated_cost_usd),
          updatedAt: row.updated_at.toISOString(),
        })),
      };
    });
  }

  async previewAudience(
    context: TenantContext,
    input: { audienceSnapshotId: string; sampleLimit: number },
  ): Promise<{
    audience: {
      id: string;
      campaignId: string;
      campaignName: string;
      definitionVersion: number;
      snapshotSha256: string;
      memberCount: number;
      sensitiveMemberCount: number;
      evidenceCutoffAt: string;
      frozenAt: string;
    };
    samples: Array<{
      customerReference: string;
      decisionReference: string;
      decisionStatus: string;
      inclusionExplanation: string;
      explanationRedacted: boolean;
      consentState: string;
    }>;
  }> {
    assertUuid(input.audienceSnapshotId, "audienceSnapshotId");
    return this.database.withTenant(context.organizationId, async (tx) => {
      const result = await this.audiencePreviewInTransaction(
        tx,
        context,
        input.audienceSnapshotId,
        input.sampleLimit,
      );
      await this.audit(tx, context, {
        action: "audience.previewed",
        resourceType: "audience_snapshot",
        resourceId: input.audienceSnapshotId,
        metadata: { sampleCount: result.samples.length },
      });
      return result;
    });
  }

  async previewCampaign(
    context: TenantContext,
    input: { campaignId: string; sampleLimit: number },
  ): Promise<{
    campaign: {
      id: string;
      name: string;
      mode: RetentionCampaignMode;
      status: string;
      revision: number;
      programName: string;
      programType: string;
      approvedAt: string | null;
    };
    audience: {
      id: string;
      memberCount: number;
      sensitiveMemberCount: number;
      snapshotSha256: string;
      frozenAt: string;
    } | null;
    messageSamples: Array<{
      customerReference: string;
      messageId: string;
      qualityStatus: string;
      subject: string | null;
      preheader: string | null;
      body: string | null;
      bodyTruncated: boolean;
      contentWithheld: boolean;
      messageSha256: string;
    }>;
  }> {
    assertUuid(input.campaignId, "campaignId");
    return this.database.withTenant(context.organizationId, async (tx) => {
      const campaigns = await tx<
        Array<{
          id: string;
          name: string;
          mode: RetentionCampaignMode;
          status: string;
          revision: number;
          program_name: string;
          program_type: string;
          approved_at: Date | null;
          audience_id: string | null;
          member_count: string | null;
          sensitive_member_count: string | null;
          snapshot_sha256: string | null;
          frozen_at: Date | null;
        }>
      >`
        SELECT
          campaign.id,
          campaign.name,
          campaign.mode,
          campaign.status,
          campaign.revision,
          program.name AS program_name,
          program.program_type,
          campaign.approved_at,
          audience.id AS audience_id,
          audience.member_count::TEXT,
          audience.sensitive_member_count::TEXT,
          audience.snapshot_sha256,
          audience.frozen_at
        FROM retention_campaigns AS campaign
        JOIN retention_programs AS program
          ON program.org_id = campaign.org_id
          AND program.id = campaign.program_id
        LEFT JOIN retention_audience_snapshots AS audience
          ON audience.org_id = campaign.org_id
          AND audience.campaign_id = campaign.id
        WHERE campaign.org_id = ${context.organizationId}
          AND campaign.id = ${input.campaignId}
      `;
      const campaign = campaigns[0];
      if (!campaign) {
        throw new RetentionServiceError(
          "campaign_not_found",
          "The retention campaign was not found.",
          404,
        );
      }
      const messages = await tx<
        Array<{
          id: string;
          customer_id: string;
          primary_email_ciphertext: string | null;
          primary_phone_ciphertext: string | null;
          display_name_ciphertext: string | null;
          subject_ciphertext: string;
          preheader_ciphertext: string | null;
          body_ciphertext: string;
          message_sha256: string;
          quality_status: string;
          sensitive_content_blocked: boolean;
          sensitive_inference_used: boolean;
        }>
      >`
        SELECT
          message.id,
          message.customer_id,
          customer.primary_email_ciphertext,
          customer.primary_phone_ciphertext,
          customer.display_name_ciphertext,
          message.subject_ciphertext,
          message.preheader_ciphertext,
          message.body_ciphertext,
          message.message_sha256,
          message.quality_status,
          message.sensitive_content_blocked,
          member.sensitive_inference_used
        FROM retention_rendered_messages AS message
        JOIN retention_customers AS customer
          ON customer.org_id = message.org_id
          AND customer.id = message.customer_id
        LEFT JOIN retention_audience_snapshots AS audience
          ON audience.org_id = message.org_id
          AND audience.campaign_id = message.campaign_id
        LEFT JOIN retention_audience_members AS member
          ON member.org_id = audience.org_id
          AND member.audience_snapshot_id = audience.id
          AND member.customer_id = message.customer_id
        WHERE message.org_id = ${context.organizationId}
          AND message.campaign_id = ${input.campaignId}
        ORDER BY message.customer_id, message.id
        LIMIT ${input.sampleLimit}
      `;
      const messageSamples = messages.map((message) => {
        const contentWithheld =
          message.sensitive_content_blocked || message.sensitive_inference_used;
        if (contentWithheld) {
          return {
            customerReference: operatorCustomerReference(
              context.organizationId,
              message.customer_id,
            ),
            messageId: message.id,
            qualityStatus: message.quality_status,
            subject: null,
            preheader: null,
            body: null,
            bodyTruncated: false,
            contentWithheld: true,
            messageSha256: message.message_sha256,
          };
        }
        const identifiers = [
          message.primary_email_ciphertext
            ? this.crypto.decrypt(
                message.primary_email_ciphertext,
                `${context.organizationId}:customer:${message.customer_id}:email`,
              )
            : null,
          message.primary_phone_ciphertext
            ? this.crypto.decrypt(
                message.primary_phone_ciphertext,
                `${context.organizationId}:customer:${message.customer_id}:phone`,
              )
            : null,
          this.decryptCustomerDisplayName(
            context.organizationId,
            message.customer_id,
            message.display_name_ciphertext,
          ),
        ].filter((value): value is string => value !== null);
        const body = redactOperatorText(
          this.crypto.decrypt(
            message.body_ciphertext,
            `${context.organizationId}:message:${message.id}:body`,
          ),
          identifiers,
        );
        return {
          customerReference: operatorCustomerReference(
            context.organizationId,
            message.customer_id,
          ),
          messageId: message.id,
          qualityStatus: message.quality_status,
          subject: redactOperatorText(
            this.crypto.decrypt(
              message.subject_ciphertext,
              `${context.organizationId}:message:${message.id}:subject`,
            ),
            identifiers,
          ),
          preheader: message.preheader_ciphertext
            ? redactOperatorText(
                this.crypto.decrypt(
                  message.preheader_ciphertext,
                  `${context.organizationId}:message:${message.id}:preheader`,
                ),
                identifiers,
              )
            : null,
          body: body.slice(0, 20_000),
          bodyTruncated: body.length > 20_000,
          contentWithheld: false,
          messageSha256: message.message_sha256,
        };
      });
      await this.audit(tx, context, {
        action: "campaign.previewed",
        resourceType: "campaign",
        resourceId: input.campaignId,
        metadata: { sampleCount: messageSamples.length },
      });
      return {
        campaign: {
          id: campaign.id,
          name: campaign.name,
          mode: campaign.mode,
          status: campaign.status,
          revision: campaign.revision,
          programName: campaign.program_name,
          programType: campaign.program_type,
          approvedAt: campaign.approved_at?.toISOString() ?? null,
        },
        audience:
          campaign.audience_id && campaign.snapshot_sha256 && campaign.frozen_at
            ? {
                id: campaign.audience_id,
                memberCount: Number(campaign.member_count ?? 0),
                sensitiveMemberCount: Number(
                  campaign.sensitive_member_count ?? 0,
                ),
                snapshotSha256: campaign.snapshot_sha256,
                frozenAt: campaign.frozen_at.toISOString(),
              }
            : null,
        messageSamples,
      };
    });
  }

  async analyzeCampaignOutcomes(
    context: TenantContext,
    input: { campaignId: string; brandId: string },
  ): Promise<{
    campaignId: string;
    campaignStatus: string;
    dispatches: Array<{
      id: string;
      status: string;
      recipientCount: number;
      acceptedCount: number;
      failedCount: number;
      releasedAt: string;
      completedAt: string | null;
      lastErrorCode: string | null;
    }>;
    recipientStatuses: Record<string, number>;
    deliveryEvents: Record<string, number>;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      estimatedCostUsd: number;
    };
  }> {
    assertUuid(input.campaignId, "campaignId");
    assertUuid(input.brandId, "brandId");
    return this.database.withTenant(context.organizationId, async (tx) => {
      const campaigns = await tx<Array<{ status: string }>>`
        SELECT status
        FROM retention_campaigns
        WHERE org_id = ${context.organizationId}
          AND id = ${input.campaignId}
          AND brand_id = ${input.brandId}
      `;
      if (!campaigns[0]) {
        throw new RetentionServiceError(
          "campaign_not_found",
          "The retention campaign was not found.",
          404,
        );
      }
      const dispatches = await tx<
        Array<{
          id: string;
          status: string;
          recipient_count: string;
          accepted_count: string;
          failed_count: string;
          released_at: Date;
          completed_at: Date | null;
          last_error_code: string | null;
        }>
      >`
        SELECT
          id,
          status,
          recipient_count::TEXT,
          accepted_count::TEXT,
          failed_count::TEXT,
          released_at,
          completed_at,
          last_error_code
        FROM retention_dispatches
        WHERE org_id = ${context.organizationId}
          AND campaign_id = ${input.campaignId}
        ORDER BY released_at, id
      `;
      const recipientRows = await tx<Array<{ status: string; count: string }>>`
        SELECT status, count(*)::TEXT AS count
        FROM retention_dispatch_recipients
        WHERE org_id = ${context.organizationId}
          AND campaign_id = ${input.campaignId}
        GROUP BY status
        ORDER BY status
      `;
      const deliveryRows = await tx<
        Array<{ event_type: string; count: string }>
      >`
        SELECT event_type, count(*)::TEXT AS count
        FROM retention_delivery_events
        WHERE org_id = ${context.organizationId}
          AND campaign_id = ${input.campaignId}
        GROUP BY event_type
        ORDER BY event_type
      `;
      const usageRows = await tx<
        Array<{
          input_tokens: string;
          output_tokens: string;
          cache_read_tokens: string;
          cache_write_tokens: string;
          estimated_cost_usd: string;
        }>
      >`
        SELECT
          COALESCE(sum(input_tokens), 0)::TEXT AS input_tokens,
          COALESCE(sum(output_tokens), 0)::TEXT AS output_tokens,
          COALESCE(sum(cache_read_tokens), 0)::TEXT AS cache_read_tokens,
          COALESCE(sum(cache_write_tokens), 0)::TEXT
            AS cache_write_tokens,
          COALESCE(sum(estimated_cost_usd), 0)::TEXT
            AS estimated_cost_usd
        FROM retention_usage_events
        WHERE org_id = ${context.organizationId}
          AND campaign_id = ${input.campaignId}
      `;
      await this.audit(tx, context, {
        action: "campaign.outcomes_viewed",
        resourceType: "campaign",
        resourceId: input.campaignId,
      });
      const usage = usageRows[0];
      return {
        campaignId: input.campaignId,
        campaignStatus: campaigns[0].status,
        dispatches: dispatches.map((dispatch) => ({
          id: dispatch.id,
          status: dispatch.status,
          recipientCount: Number(dispatch.recipient_count),
          acceptedCount: Number(dispatch.accepted_count),
          failedCount: Number(dispatch.failed_count),
          releasedAt: dispatch.released_at.toISOString(),
          completedAt: dispatch.completed_at?.toISOString() ?? null,
          lastErrorCode: dispatch.last_error_code,
        })),
        recipientStatuses: Object.fromEntries(
          recipientRows.map((row) => [row.status, Number(row.count)]),
        ),
        deliveryEvents: Object.fromEntries(
          deliveryRows.map((row) => [row.event_type, Number(row.count)]),
        ),
        usage: {
          inputTokens: Number(usage?.input_tokens ?? 0),
          outputTokens: Number(usage?.output_tokens ?? 0),
          cacheReadTokens: Number(usage?.cache_read_tokens ?? 0),
          cacheWriteTokens: Number(usage?.cache_write_tokens ?? 0),
          estimatedCostUsd: Number(usage?.estimated_cost_usd ?? 0),
        },
      };
    });
  }

  async cancelCampaign(
    context: TenantContext,
    input: { campaignId: string; brandId: string; reason: string },
  ): Promise<{
    campaignId: string;
    status: "cancelled";
    cancelledDispatchCount: number;
    cancelledRecipientCount: number;
    duplicate: boolean;
  }> {
    assertUuid(input.campaignId, "campaignId");
    assertUuid(input.brandId, "brandId");
    if (
      !context.permissions.includes("retention:write") &&
      !context.permissions.includes("retention:*")
    ) {
      throw new RetentionServiceError(
        "campaign_cancellation_permission_required",
        "Retention campaign write permission is required.",
        403,
      );
    }
    return this.database.withTenant(context.organizationId, async (tx) => {
      const campaigns = await tx<Array<{ status: string }>>`
        SELECT status
        FROM retention_campaigns
        WHERE org_id = ${context.organizationId}
          AND id = ${input.campaignId}
          AND brand_id = ${input.brandId}
        FOR UPDATE
      `;
      const campaign = campaigns[0];
      if (!campaign) {
        throw new RetentionServiceError(
          "campaign_not_found",
          "The retention campaign was not found.",
          404,
        );
      }
      const dispatches = await tx<
        Array<{
          id: string;
          status: string;
          accepted_count: string;
          provider_campaign_id: string | null;
          provider_list_id: string | null;
          provider_payload_reference: string | null;
        }>
      >`
        SELECT
          id,
          status,
          accepted_count::TEXT,
          provider_campaign_id,
          provider_list_id,
          provider_payload_reference
        FROM retention_dispatches
        WHERE org_id = ${context.organizationId}
          AND campaign_id = ${input.campaignId}
        ORDER BY id
        FOR UPDATE
      `;
      if (
        dispatches.length > 0 &&
        !context.permissions.includes("retention:send") &&
        !context.permissions.includes("retention:*")
      ) {
        throw new RetentionServiceError(
          "campaign_cancellation_sender_permission_required",
          "Retention campaign sender permission is required after release.",
          403,
        );
      }
      const acceptanceRows = await tx<Array<{ accepted_count: string }>>`
        SELECT count(*)::TEXT AS accepted_count
        FROM retention_dispatch_recipients
        WHERE org_id = ${context.organizationId}
          AND campaign_id = ${input.campaignId}
          AND (
            status = 'accepted'
            OR provider_acceptance_id IS NOT NULL
            OR accepted_at IS NOT NULL
          )
      `;
      const runningJobRows =
        dispatches.length === 0
          ? [{ running_count: "0" }]
          : await tx<Array<{ running_count: string }>>`
              SELECT count(*)::TEXT AS running_count
              FROM retention_jobs
              WHERE org_id = ${context.organizationId}
                AND job_type = 'dispatch_campaign'
                AND status = 'running'
                AND dedupe_key = ANY(
                  ${tx.array(dispatches.map((row) => row.id))}
                )
            `;
      assertCampaignCanCancel({
        campaignStatus: campaign.status,
        dispatches: dispatches.map((dispatch) => ({
          status: dispatch.status,
          acceptedCount: Number(dispatch.accepted_count),
          providerCampaignId: dispatch.provider_campaign_id,
          providerListId: dispatch.provider_list_id,
          providerPayloadReference: dispatch.provider_payload_reference,
        })),
        acceptedRecipientCount: Number(acceptanceRows[0]?.accepted_count ?? 0),
        runningDispatchJobCount: Number(runningJobRows[0]?.running_count ?? 0),
      });
      if (campaign.status === "cancelled") {
        return {
          campaignId: input.campaignId,
          status: "cancelled",
          cancelledDispatchCount: 0,
          cancelledRecipientCount: 0,
          duplicate: true,
        };
      }
      const cancelledRecipients = await tx<Array<{ id: string }>>`
        UPDATE retention_dispatch_recipients
        SET status = 'cancelled', updated_at = now()
        WHERE org_id = ${context.organizationId}
          AND campaign_id = ${input.campaignId}
          AND status IN ('pending', 'failed', 'suppressed')
        RETURNING id
      `;
      const cancelledDispatches = await tx<Array<{ id: string }>>`
        UPDATE retention_dispatches
        SET status = 'cancelled', completed_at = now(), updated_at = now()
        WHERE org_id = ${context.organizationId}
          AND campaign_id = ${input.campaignId}
          AND status IN ('pending', 'failed')
        RETURNING id
      `;
      if (dispatches.length > 0) {
        await tx`
          UPDATE retention_jobs
          SET status = 'cancelled', completed_at = now(), updated_at = now()
          WHERE org_id = ${context.organizationId}
            AND job_type = 'dispatch_campaign'
            AND status = 'queued'
            AND dedupe_key = ANY(
              ${tx.array(dispatches.map((row) => row.id))}
            )
        `;
      }
      await tx`
        UPDATE retention_approvals
        SET status = 'invalidated', invalidated_at = now()
        WHERE org_id = ${context.organizationId}
          AND campaign_id = ${input.campaignId}
          AND status IN ('pending', 'approved')
      `;
      await tx`
        UPDATE retention_budget_reservations
        SET status = 'released', updated_at = now()
        WHERE org_id = ${context.organizationId}
          AND campaign_id = ${input.campaignId}
          AND status = 'reserved'
      `;
      await tx`
        UPDATE retention_campaigns
        SET
          status = 'cancelled',
          approval_snapshot_sha256 = NULL,
          approved_by = NULL,
          approved_at = NULL,
          updated_at = now()
        WHERE org_id = ${context.organizationId}
          AND id = ${input.campaignId}
      `;
      await this.audit(tx, context, {
        action: "campaign.cancelled",
        resourceType: "campaign",
        resourceId: input.campaignId,
        metadata: {
          reasonSha256: sha256(input.reason.trim()),
          cancelledDispatchCount: cancelledDispatches.length,
          cancelledRecipientCount: cancelledRecipients.length,
        },
      });
      return {
        campaignId: input.campaignId,
        status: "cancelled",
        cancelledDispatchCount: cancelledDispatches.length,
        cancelledRecipientCount: cancelledRecipients.length,
        duplicate: false,
      };
    });
  }

  async claimJob(
    organizationId: string,
    workerId: string,
    acceptedTypes: readonly string[],
  ): Promise<{
    id: string;
    type: string;
    payload: unknown;
    attempts: number;
  } | null> {
    if (acceptedTypes.length === 0) return null;
    return this.database.withTenant(organizationId, async (tx) => {
      const rows = await tx<
        Array<{
          id: string;
          job_type: string;
          payload_ciphertext: string;
          attempts: number;
        }>
      >`
        WITH candidate AS (
          SELECT id
          FROM retention_jobs
          WHERE org_id = ${organizationId}
            AND (
              status = 'queued'
              OR (
                status = 'running'
                AND lease_expires_at IS NOT NULL
                AND lease_expires_at <= now()
              )
            )
            AND job_type = ANY(${tx.array([...acceptedTypes])}::TEXT[])
            AND available_at <= now()
          ORDER BY available_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE retention_jobs AS job
        SET
          status = 'running',
          lease_owner = ${workerId},
          lease_expires_at = now() + ${this.options.jobLeaseSeconds} * interval '1 second',
          attempts = attempts + 1,
          updated_at = now()
        FROM candidate
        WHERE job.org_id = ${organizationId}
          AND job.id = candidate.id
        RETURNING job.id, job.job_type, job.payload_ciphertext, job.attempts
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        type: row.job_type,
        payload: JSON.parse(
          this.crypto.decrypt(
            row.payload_ciphertext,
            `${organizationId}:job:${row.id}:payload`,
          ),
        ),
        attempts: row.attempts,
      };
    });
  }

  async completeJob(
    organizationId: string,
    workerId: string,
    jobId: string,
  ): Promise<void> {
    await this.database.withTenant(organizationId, async (tx) => {
      const result = await tx`
        UPDATE retention_jobs
        SET
          status = 'completed',
          completed_at = now(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
        WHERE org_id = ${organizationId}
          AND id = ${jobId}
          AND status = 'running'
          AND lease_owner = ${workerId}
          AND lease_expires_at > now()
        RETURNING id
      `;
      if (result.length === 0) {
        throw new RetentionServiceError(
          "job_lease_lost",
          "The retention job lease is no longer active.",
          409,
        );
      }
    });
  }

  async failJob(
    organizationId: string,
    workerId: string,
    jobId: string,
    error: { code: string; message: string },
  ): Promise<void> {
    await this.database.withTenant(organizationId, async (tx) => {
      await tx`
        UPDATE retention_jobs
        SET
          status = CASE
            WHEN attempts >= max_attempts THEN 'dead_letter'
            ELSE 'queued'
          END,
          available_at = CASE
            WHEN attempts >= max_attempts THEN available_at
            ELSE now() + LEAST(3600, power(2, attempts)) * interval '1 second'
          END,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error_code = ${error.code},
          last_error_message = ${error.message.slice(0, 500)},
          updated_at = now()
        WHERE org_id = ${organizationId}
          AND id = ${jobId}
          AND status = 'running'
          AND lease_owner = ${workerId}
          AND lease_expires_at > now()
      `;
    });
  }

  async campaignApprovalPreview(
    context: TenantContext,
    campaignId: string,
    brandId: string,
  ): Promise<{ snapshotSha256: string; material: CampaignApprovalMaterial }> {
    assertUuid(campaignId, "campaignId");
    assertUuid(brandId, "brandId");
    return this.database.withTenant(context.organizationId, async (tx) => {
      const material = await this.currentApprovalMaterial(
        tx,
        context.organizationId,
        campaignId,
        brandId,
      );
      const checksum = getCampaignApprovalChecksum(material);
      if (!checksum.ok) {
        throw new RetentionServiceError(
          checksum.error.code,
          checksum.error.message,
          409,
          checksum.error.details ? { ...checksum.error.details } : undefined,
        );
      }
      return { snapshotSha256: checksum.value, material };
    });
  }

  private async audiencePreviewInTransaction(
    tx: RetentionTransactionSql,
    context: TenantContext,
    audienceSnapshotId: string,
    sampleLimit: number,
  ): Promise<{
    audience: {
      id: string;
      campaignId: string;
      campaignName: string;
      definitionVersion: number;
      snapshotSha256: string;
      memberCount: number;
      sensitiveMemberCount: number;
      evidenceCutoffAt: string;
      frozenAt: string;
    };
    samples: Array<{
      customerReference: string;
      decisionReference: string;
      decisionStatus: string;
      inclusionExplanation: string;
      explanationRedacted: boolean;
      consentState: string;
    }>;
  }> {
    const audiences = await tx<
      Array<{
        id: string;
        campaign_id: string;
        campaign_name: string;
        definition_version: number;
        snapshot_sha256: string;
        member_count: string;
        sensitive_member_count: string;
        evidence_cutoff_at: Date;
        frozen_at: Date;
      }>
    >`
      SELECT
        audience.id,
        audience.campaign_id,
        campaign.name AS campaign_name,
        audience.definition_version,
        audience.snapshot_sha256,
        audience.member_count::TEXT,
        audience.sensitive_member_count::TEXT,
        audience.evidence_cutoff_at,
        audience.frozen_at
      FROM retention_audience_snapshots AS audience
      JOIN retention_campaigns AS campaign
        ON campaign.org_id = audience.org_id
        AND campaign.id = audience.campaign_id
      WHERE audience.org_id = ${context.organizationId}
        AND audience.id = ${audienceSnapshotId}
    `;
    const audience = audiences[0];
    if (!audience) {
      throw new RetentionServiceError(
        "audience_not_found",
        "The retention audience was not found.",
        404,
      );
    }
    const rows = await tx<
      Array<{
        customer_id: string;
        decision_id: string;
        decision_status: string;
        inclusion_explanation_ciphertext: string;
        sensitive_inference_used: boolean;
        consent_state: string;
        primary_email_ciphertext: string | null;
        primary_phone_ciphertext: string | null;
        display_name_ciphertext: string | null;
      }>
    >`
      SELECT
        member.customer_id,
        member.decision_id,
        decision.status AS decision_status,
        member.inclusion_explanation_ciphertext,
        member.sensitive_inference_used,
        member.consent_state,
        customer.primary_email_ciphertext,
        customer.primary_phone_ciphertext,
        customer.display_name_ciphertext
      FROM retention_audience_members AS member
      JOIN retention_customer_decisions AS decision
        ON decision.org_id = member.org_id
        AND decision.id = member.decision_id
      JOIN retention_customers AS customer
        ON customer.org_id = member.org_id
        AND customer.id = member.customer_id
      WHERE member.org_id = ${context.organizationId}
        AND member.audience_snapshot_id = ${audienceSnapshotId}
      ORDER BY member.customer_id
      LIMIT ${sampleLimit}
    `;
    return {
      audience: {
        id: audience.id,
        campaignId: audience.campaign_id,
        campaignName: audience.campaign_name,
        definitionVersion: audience.definition_version,
        snapshotSha256: audience.snapshot_sha256,
        memberCount: Number(audience.member_count),
        sensitiveMemberCount: Number(audience.sensitive_member_count),
        evidenceCutoffAt: audience.evidence_cutoff_at.toISOString(),
        frozenAt: audience.frozen_at.toISOString(),
      },
      samples: rows.map((row) => {
        if (row.sensitive_inference_used) {
          return {
            customerReference: operatorCustomerReference(
              context.organizationId,
              row.customer_id,
            ),
            decisionReference: `decision_${sha256(row.decision_id).slice(0, 12)}`,
            decisionStatus: row.decision_status,
            inclusionExplanation:
              "Sensitive evidence contributed to inclusion. The underlying trait and evidence are withheld.",
            explanationRedacted: true,
            consentState: row.consent_state,
          };
        }
        const identifiers = [
          row.primary_email_ciphertext
            ? this.crypto.decrypt(
                row.primary_email_ciphertext,
                `${context.organizationId}:customer:${row.customer_id}:email`,
              )
            : null,
          row.primary_phone_ciphertext
            ? this.crypto.decrypt(
                row.primary_phone_ciphertext,
                `${context.organizationId}:customer:${row.customer_id}:phone`,
              )
            : null,
          this.decryptCustomerDisplayName(
            context.organizationId,
            row.customer_id,
            row.display_name_ciphertext,
          ),
        ].filter((value): value is string => value !== null);
        return {
          customerReference: operatorCustomerReference(
            context.organizationId,
            row.customer_id,
          ),
          decisionReference: `decision_${sha256(row.decision_id).slice(0, 12)}`,
          decisionStatus: row.decision_status,
          inclusionExplanation: redactOperatorText(
            this.crypto.decrypt(
              row.inclusion_explanation_ciphertext,
              `${context.organizationId}:audience:${audienceSnapshotId}:customer:${row.customer_id}:explanation`,
            ),
            identifiers,
          ),
          explanationRedacted: false,
          consentState: row.consent_state,
        };
      }),
    };
  }

  private async currentApprovalMaterial(
    tx: RetentionTransactionSql,
    organizationId: string,
    campaignId: string,
    brandId: string,
  ): Promise<CampaignApprovalMaterial> {
    const campaigns = await tx<
      Array<{
        id: string;
        revision: number;
        mode: RetentionCampaignMode;
        program_type: RetentionProgram;
        audience_id: string | null;
        audience_sha256: string | null;
        audience_member_count: string | null;
        strategy_ciphertext: string | null;
        strategy_version: string | null;
        model_provider: string | null;
        model_id: string | null;
        prompt_version: string | null;
      }>
      >`
      SELECT
        campaign.id,
        campaign.revision,
        campaign.mode,
        program.program_type,
        audience.id AS audience_id,
        audience.snapshot_sha256 AS audience_sha256,
        audience.member_count::TEXT AS audience_member_count,
        campaign.strategy_ciphertext,
        campaign.strategy_version,
        campaign.model_provider,
        campaign.model_id,
        campaign.prompt_version
      FROM retention_campaigns AS campaign
      JOIN retention_programs AS program
        ON program.org_id = campaign.org_id
        AND program.id = campaign.program_id
      LEFT JOIN retention_audience_snapshots AS audience
        ON audience.org_id = campaign.org_id
        AND audience.campaign_id = campaign.id
      WHERE campaign.org_id = ${organizationId}
        AND campaign.id = ${campaignId}
        AND campaign.brand_id = ${brandId}
    `;
    const campaign = campaigns[0];
    if (!campaign) {
      throw new RetentionServiceError(
        "campaign_not_found",
        "The retention campaign was not found.",
        404,
      );
    }
    if (!campaign.audience_id || !campaign.audience_sha256) {
      throw new RetentionServiceError(
        "campaign_not_ready",
        "The campaign audience has not been frozen.",
        409,
      );
    }
    if (
      !campaign.strategy_ciphertext ||
      !campaign.strategy_version ||
      !campaign.model_provider ||
      !campaign.model_id ||
      !campaign.prompt_version
    ) {
      throw new RetentionServiceError(
        "campaign_not_ready",
        "The campaign strategy and generation model have not been frozen.",
        409,
      );
    }

    const decisions = await tx<
      Array<{
        id: string;
        status: string;
        objective: string | null;
        recommended_timing: Date | null;
        recommended_offer: unknown;
        reasoning_ciphertext: string | null;
        competing_hypotheses_ciphertext: string | null;
        confidence: string | null;
        model_provider: string | null;
        model_id: string | null;
        prompt_version: string | null;
        input_evidence_cutoff_at: Date;
        reasoned_at: Date | null;
        invalidated_at: Date | null;
        updated_at: Date;
      }>
    >`
      SELECT
        decision.id,
        decision.status,
        decision.objective,
        decision.recommended_timing,
        decision.recommended_offer,
        decision.reasoning_ciphertext,
        decision.competing_hypotheses_ciphertext,
        decision.confidence::TEXT,
        decision.model_provider,
        decision.model_id,
        decision.prompt_version,
        decision.input_evidence_cutoff_at,
        decision.reasoned_at,
        decision.invalidated_at,
        decision.updated_at
      FROM retention_audience_members AS member
      JOIN retention_customer_decisions AS decision
        ON decision.org_id = member.org_id
        AND decision.id = member.decision_id
      WHERE member.org_id = ${organizationId}
        AND member.audience_snapshot_id = ${campaign.audience_id}
      ORDER BY decision.id
    `;
    const messages = await tx<
      Array<{
        id: string;
        message_sha256: string;
        model_provider: string;
        model_id: string;
        prompt_version: string;
      }>
    >`
      SELECT
        id,
        message_sha256,
        model_provider,
        model_id,
        prompt_version
      FROM retention_rendered_messages
      WHERE org_id = ${organizationId}
        AND campaign_id = ${campaignId}
        AND quality_status IN ('passed', 'needs_review')
        AND sensitive_content_blocked = false
      ORDER BY id
    `;
    const audienceMemberCount = Number(campaign.audience_member_count ?? 0);
    const decisionsComplete =
      audienceMemberCount > 0 &&
      decisions.length === audienceMemberCount &&
      decisions.every(
        (decision) =>
          decision.status === "eligible" &&
          decision.reasoned_at !== null &&
          decision.invalidated_at === null,
      );
    const messagesComplete = messages.length === audienceMemberCount;
    if (!decisionsComplete || !messagesComplete) {
      throw new RetentionServiceError(
        "campaign_not_ready",
        "Every frozen recipient requires a current eligible AI decision and an approved-quality message.",
        409,
        {
          audienceMemberCount,
          decisionCount: decisions.length,
          messageCount: messages.length,
        },
      );
    }

    const modelReferences = new Set<string>();
    const promptReferences = new Set<string>();
    if (campaign.model_provider && campaign.model_id) {
      modelReferences.add(`${campaign.model_provider}:${campaign.model_id}`);
    }
    if (campaign.prompt_version) {
      promptReferences.add(campaign.prompt_version);
    }
    for (const decision of decisions) {
      if (decision.model_provider && decision.model_id) {
        modelReferences.add(`${decision.model_provider}:${decision.model_id}`);
      }
      if (decision.prompt_version) {
        promptReferences.add(decision.prompt_version);
      }
    }
    for (const message of messages) {
      modelReferences.add(`${message.model_provider}:${message.model_id}`);
      promptReferences.add(message.prompt_version);
    }

    const offerMaterial = decisions.map((decision) => ({
      id: decision.id,
      offer: decision.recommended_offer,
    }));
    return {
      orgId: organizationId,
      campaignId,
      campaignRevision: campaign.revision,
      program: campaign.program_type,
      mode: campaign.mode,
      audienceSnapshotId: campaign.audience_id,
      audienceChecksum: campaign.audience_sha256,
      recipientDecisions: decisions.map((decision) => ({
        id: decision.id,
        checksum: sha256(
          canonicalJson({
            ...decision,
            recommended_timing:
              decision.recommended_timing?.toISOString() ?? null,
            input_evidence_cutoff_at:
              decision.input_evidence_cutoff_at.toISOString(),
            reasoned_at: decision.reasoned_at?.toISOString() ?? null,
            updated_at: decision.updated_at.toISOString(),
          }),
        ),
      })),
      content: messages.map((message) => ({
        id: message.id,
        checksum: message.message_sha256,
      })),
      modelReferences: [...modelReferences].sort(),
      promptReferences: [...promptReferences].sort(),
      offerChecksum: sha256(canonicalJson(offerMaterial)),
    };
  }

  private async createDispatchRecipients(
    tx: RetentionTransactionSql,
    organizationId: string,
    campaignId: string,
    dispatchId: string,
  ): Promise<void> {
    const rows = await tx<
      Array<{
        customer_id: string;
        email_ciphertext: string | null;
        consent_event_id: string | null;
        consent_state: string | null;
        message_id: string | null;
        subject_ciphertext: string | null;
        preheader_ciphertext: string | null;
        body_ciphertext: string | null;
        offer_ciphertext: string | null;
      }>
    >`
      SELECT
        member.customer_id,
        customer.primary_email_ciphertext AS email_ciphertext,
        consent.id AS consent_event_id,
        consent.state AS consent_state,
        message.id AS message_id,
        message.subject_ciphertext,
        message.preheader_ciphertext,
        message.body_ciphertext,
        message.offer_ciphertext
      FROM retention_audience_snapshots AS audience
      JOIN retention_audience_members AS member
        ON member.org_id = audience.org_id
        AND member.audience_snapshot_id = audience.id
      JOIN retention_customers AS customer
        ON customer.org_id = member.org_id
        AND customer.id = member.customer_id
      LEFT JOIN LATERAL (
        SELECT id, state
        FROM retention_consent_events
        WHERE org_id = member.org_id
          AND customer_id = member.customer_id
          AND channel = 'email'
        ORDER BY occurred_at DESC, created_at DESC
        LIMIT 1
      ) AS consent ON true
      LEFT JOIN retention_rendered_messages AS message
        ON message.org_id = member.org_id
        AND message.campaign_id = audience.campaign_id
        AND message.customer_id = member.customer_id
      WHERE audience.org_id = ${organizationId}
        AND audience.campaign_id = ${campaignId}
      ORDER BY member.customer_id
      FOR UPDATE OF customer
    `;
    for (const row of rows) {
      const canSend =
        row.consent_state === "subscribed" &&
        row.email_ciphertext !== null &&
        row.message_id !== null &&
        row.subject_ciphertext !== null &&
        row.body_ciphertext !== null;
      const recipientId = randomUUID();
      const content = canSend
        ? {
            recipientIdentifier: this.crypto.decrypt(
              row.email_ciphertext!,
              `${organizationId}:customer:${row.customer_id}:email`,
            ),
            subject: this.crypto.decrypt(
              row.subject_ciphertext!,
              `${organizationId}:message:${row.message_id}:subject`,
            ),
            preheader: row.preheader_ciphertext
              ? this.crypto.decrypt(
                  row.preheader_ciphertext,
                  `${organizationId}:message:${row.message_id}:preheader`,
                )
              : null,
            body: this.crypto.decrypt(
              row.body_ciphertext!,
              `${organizationId}:message:${row.message_id}:body`,
            ),
            offer: row.offer_ciphertext
              ? this.crypto.decrypt(
                  row.offer_ciphertext,
                  `${organizationId}:message:${row.message_id}:offer`,
                )
              : null,
          }
        : null;
      await tx`
        INSERT INTO retention_dispatch_recipients (
          id,
          org_id,
          dispatch_id,
          campaign_id,
          customer_id,
          opaque_recipient_id,
          content_ciphertext,
          consent_event_id,
          status
        )
        VALUES (
          ${recipientId},
          ${organizationId},
          ${dispatchId},
          ${campaignId},
          ${row.customer_id},
          ${randomUUID()},
          ${
            content
              ? this.crypto.encrypt(
                  canonicalJson(content),
                  `${organizationId}:dispatch-recipient:${recipientId}:content`,
                )
              : null
          },
          ${row.consent_event_id},
          ${canSend ? "pending" : "suppressed"}
        )
      `;
    }
    await tx`
      UPDATE retention_dispatches
      SET
        recipient_count = (
          SELECT count(*)
          FROM retention_dispatch_recipients
          WHERE org_id = ${organizationId}
            AND dispatch_id = ${dispatchId}
            AND status = 'pending'
        ),
        updated_at = now()
      WHERE org_id = ${organizationId}
        AND id = ${dispatchId}
    `;
  }

  private async recordDeliveryEvent(
    tx: RetentionTransactionSql,
    organizationId: string,
    event: ProcessedSourceEvent,
    customerId: string | null,
    payload: NormalizedSourcePayload,
  ): Promise<void> {
    if (!payload.delivery) return;
    await tx`
      INSERT INTO retention_delivery_events (
        id,
        org_id,
        customer_id,
        provider_event_id,
        event_type,
        occurred_at,
        metadata
      )
      VALUES (
        ${randomUUID()},
        ${organizationId},
        ${customerId},
        ${event.external_event_id},
        ${event.event_type},
        ${event.occurred_at},
        ${tx.json({ sourceProvider: event.provider })}
      )
      ON CONFLICT (org_id, provider_event_id) DO NOTHING
    `;
  }

  private async eraseCustomer(
    tx: RetentionTransactionSql,
    organizationId: string,
    customerId: string,
    sourceEventId?: string,
    privacyRequestId?: string,
  ): Promise<{
    rawPayloadsDeleted: number;
    rawPayloadDeletionIds: string[];
  }> {
    const customers = await tx<
      Array<{
        brand_id: string;
        status: string;
        primary_email_blind_index: string | null;
        primary_phone_blind_index: string | null;
      }>
    >`
      SELECT
        brand_id,
        status,
        primary_email_blind_index,
        primary_phone_blind_index
      FROM retention_customers
      WHERE org_id = ${organizationId}
        AND id = ${customerId}
      FOR UPDATE
    `;
    const customer = customers[0];
    if (!customer) {
      return { rawPayloadsDeleted: 0, rawPayloadDeletionIds: [] };
    }

    await tx`
      INSERT INTO retention_customer_erasure_tombstones (
        id,
        org_id,
        brand_id,
        customer_id,
        primary_email_blind_index,
        primary_phone_blind_index
      )
      VALUES (
        ${randomUUID()},
        ${organizationId},
        ${customer.brand_id},
        ${customerId},
        ${customer.primary_email_blind_index},
        ${customer.primary_phone_blind_index}
      )
      ON CONFLICT (org_id, customer_id)
      DO UPDATE SET
        primary_email_blind_index = COALESCE(
          retention_customer_erasure_tombstones.primary_email_blind_index,
          excluded.primary_email_blind_index
        ),
        primary_phone_blind_index = COALESCE(
          retention_customer_erasure_tombstones.primary_phone_blind_index,
          excluded.primary_phone_blind_index
        )
    `;
    const identities = await tx<
      Array<{
        brand_id: string;
        provider: string;
        identity_type: string;
        external_id_blind_index: string;
      }>
    >`
      SELECT
        brand_id,
        provider,
        identity_type,
        external_id_blind_index
      FROM retention_customer_identities
      WHERE org_id = ${organizationId}
        AND customer_id = ${customerId}
    `;
    for (const identity of identities) {
      await tx`
        INSERT INTO retention_identity_erasure_tombstones (
          id,
          org_id,
          brand_id,
          customer_id,
          provider,
          identity_type,
          external_id_blind_index
        )
        VALUES (
          ${randomUUID()},
          ${organizationId},
          ${identity.brand_id},
          ${customerId},
          ${identity.provider},
          ${identity.identity_type},
          ${identity.external_id_blind_index}
        )
        ON CONFLICT (
          org_id,
          brand_id,
          provider,
          identity_type,
          external_id_blind_index
        )
        DO NOTHING
      `;
    }
    const sourceEvents = await tx<
      Array<{ id: string; raw_payload_ref: string }>
    >`
      SELECT id, raw_payload_ref
      FROM retention_source_events
      WHERE org_id = ${organizationId}
        AND (
          customer_id = ${customerId}
          OR id = ${sourceEventId ?? null}::UUID
        )
      ORDER BY occurred_at, id
    `;
    const rawPayloadDeletionIds: string[] = [];
    for (const sourceEvent of sourceEvents) {
      const deletionId = await this.scrubSourceEvent(
        tx,
        organizationId,
        sourceEvent.id,
        sourceEvent.raw_payload_ref,
        customerId,
        sourceEvent.id === sourceEventId ? "processed" : "ignored",
        privacyRequestId ?? null,
      );
      if (deletionId) rawPayloadDeletionIds.push(deletionId);
    }
    await tx`
      DELETE FROM retention_customer_identities
      WHERE org_id = ${organizationId}
        AND customer_id = ${customerId}
    `;
    await tx`
      DELETE FROM retention_customer_traits
      WHERE org_id = ${organizationId}
        AND customer_id = ${customerId}
    `;
    await tx`
      DELETE FROM retention_segment_memberships
      WHERE org_id = ${organizationId}
        AND customer_id = ${customerId}
    `;
    await tx`
      DELETE FROM retention_feature_snapshots
      WHERE org_id = ${organizationId}
        AND customer_id = ${customerId}
    `;
    await tx`
      DELETE FROM retention_identity_conflicts
      WHERE org_id = ${organizationId}
        AND ${customerId}::UUID = ANY(candidate_customer_ids)
    `;
    await tx`
      UPDATE retention_customer_decisions
      SET
        status = 'expired',
        objective = NULL,
        recommended_offer = NULL,
        reasoning_ciphertext = NULL,
        competing_hypotheses_ciphertext = NULL,
        invalidated_at = now(),
        updated_at = now()
      WHERE org_id = ${organizationId}
        AND customer_id = ${customerId}
    `;
    const audienceMemberships = await tx<
      Array<{ audience_snapshot_id: string }>
    >`
      SELECT audience_snapshot_id
      FROM retention_audience_members
      WHERE org_id = ${organizationId}
        AND customer_id = ${customerId}
    `;
    for (const membership of audienceMemberships) {
      await tx`
        UPDATE retention_audience_members
        SET
          inclusion_explanation_ciphertext = ${this.crypto.encrypt(
            '{"privacyErased":true}',
            `${organizationId}:audience:${membership.audience_snapshot_id}:customer:${customerId}:explanation`,
          )},
          sensitive_inference_used = false,
          consent_state = 'unknown'
        WHERE org_id = ${organizationId}
          AND audience_snapshot_id = ${membership.audience_snapshot_id}
          AND customer_id = ${customerId}
      `;
    }
    await tx`
      DELETE FROM retention_rendered_messages
      WHERE org_id = ${organizationId}
        AND customer_id = ${customerId}
    `;
    await tx`
      UPDATE retention_dispatch_recipients
      SET
        content_ciphertext = NULL,
        status = CASE
          WHEN status IN ('pending', 'failed') THEN 'cancelled'
          ELSE status
        END,
        updated_at = now()
      WHERE org_id = ${organizationId}
        AND customer_id = ${customerId}
    `;
    await tx`
      UPDATE retention_delivery_events
      SET metadata = '{}'::JSONB
      WHERE org_id = ${organizationId}
        AND customer_id = ${customerId}
    `;
    await tx`
      UPDATE retention_usage_events
      SET customer_id = NULL
      WHERE org_id = ${organizationId}
        AND customer_id = ${customerId}
    `;
    const jobs = await tx<Array<{ id: string }>>`
      SELECT id
      FROM retention_jobs
      WHERE org_id = ${organizationId}
        AND (
          (
            job_type = 'reason_customer'
            AND dedupe_key LIKE ${`%:${customerId}:%`}
          )
          OR dedupe_key = ANY(
            ${tx.array(sourceEvents.map((event) => event.id))}::TEXT[]
          )
        )
        AND NOT (
          ${sourceEventId ?? null}::TEXT IS NOT NULL
          AND dedupe_key = ${sourceEventId ?? null}
        )
    `;
    for (const job of jobs) {
      await tx`
        UPDATE retention_jobs
        SET
          status = CASE
            WHEN status IN ('queued', 'running') THEN 'cancelled'
            ELSE status
          END,
          payload_ciphertext = ${this.crypto.encrypt(
            '{"privacyErased":true}',
            `${organizationId}:job:${job.id}:payload`,
          )},
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
        WHERE org_id = ${organizationId}
          AND id = ${job.id}
      `;
    }
    await tx`
      UPDATE retention_customers
      SET
        status = 'deleted',
        primary_email_ciphertext = NULL,
        primary_email_blind_index = NULL,
        primary_phone_ciphertext = NULL,
        primary_phone_blind_index = NULL,
        display_name_ciphertext = NULL,
        updated_at = now()
      WHERE org_id = ${organizationId}
        AND id = ${customerId}
    `;
    return {
      rawPayloadsDeleted: rawPayloadDeletionIds.length,
      rawPayloadDeletionIds,
    };
  }

  private async scrubSourceEvent(
    tx: RetentionTransactionSql,
    organizationId: string,
    eventId: string,
    rawPayloadRef: string,
    customerId: string | null,
    status: "processed" | "ignored",
    privacyRequestId: string | null = null,
  ): Promise<string | null> {
    const hasRawPayload = rawPayloadRef.startsWith("source-events/");
    let deletionId: string | null = null;
    if (hasRawPayload) {
      deletionId = stableUuid(
        [organizationId, eventId, rawPayloadRef, "delete"].join(":"),
      );
      await tx`
        INSERT INTO retention_raw_payload_deletions (
          id,
          org_id,
          source_event_id,
          privacy_request_id,
          raw_payload_ref
        )
        VALUES (
          ${deletionId},
          ${organizationId},
          ${eventId},
          ${privacyRequestId},
          ${rawPayloadRef}
        )
        ON CONFLICT (org_id, source_event_id, raw_payload_ref)
        DO UPDATE SET
          privacy_request_id = COALESCE(
            retention_raw_payload_deletions.privacy_request_id,
            EXCLUDED.privacy_request_id
          ),
          updated_at = now()
      `;
      await this.enqueueJob(tx, organizationId, {
        id: randomUUID(),
        type: "delete_raw_payload",
        dedupeKey: deletionId,
        payload: { deletionId },
      });
    }
    await tx`
      UPDATE retention_source_events
      SET
        customer_id = ${customerId},
        customer_external_id_ciphertext = NULL,
        raw_payload_ref = ${`privacy-erased/${eventId}`},
        payload_ciphertext = ${this.crypto.encrypt(
          '{"privacyErased":true}',
          `${organizationId}:source-event:${eventId}:payload`,
        )},
        payload_sha256 = ${sha256('{"privacyErased":true}')},
        processing_status = ${status},
        processed_at = now()
      WHERE org_id = ${organizationId}
        AND id = ${eventId}
    `;
    return deletionId;
  }

  private async revokeIntegrationFromSource(
    tx: RetentionTransactionSql,
    organizationId: string,
    integrationId: string,
    sourceEventId: string,
  ): Promise<void> {
    await tx`
      UPDATE retention_integrations
      SET
        status = 'revoked',
        credential_ciphertext = NULL,
        webhook_secret_ciphertext = NULL,
        cursor = '{}'::JSONB,
        last_error_code = NULL,
        last_error_message = NULL,
        updated_at = now()
      WHERE org_id = ${organizationId}
        AND id = ${integrationId}
    `;
    await tx`
      UPDATE retention_migration_runs
      SET
        status = 'cancelled',
        completed_at = COALESCE(completed_at, now()),
        updated_at = now()
      WHERE org_id = ${organizationId}
        AND integration_id = ${integrationId}
        AND status IN ('preview', 'approved', 'running', 'paused')
    `;
    await this.auditSystem(tx, organizationId, {
      action: "integration.revoked_from_uninstall",
      resourceType: "integration",
      resourceId: integrationId,
      metadata: { sourceEventId },
    });
  }

  private async eraseBrand(
    tx: RetentionTransactionSql,
    organizationId: string,
    brandId: string,
    integrationId: string,
    sourceEventId: string,
  ): Promise<void> {
    const customers = await tx<Array<{ id: string }>>`
      SELECT id
      FROM retention_customers
      WHERE org_id = ${organizationId}
        AND brand_id = ${brandId}
        AND status <> 'deleted'
      ORDER BY id
      FOR UPDATE
    `;
    let rawPayloadsDeleted = 0;
    for (const customer of customers) {
      const erased = await this.eraseCustomer(tx, organizationId, customer.id);
      rawPayloadsDeleted += erased.rawPayloadsDeleted;
    }
    const remainingEvents = await tx<
      Array<{ id: string; raw_payload_ref: string }>
    >`
      SELECT id, raw_payload_ref
      FROM retention_source_events
      WHERE org_id = ${organizationId}
        AND brand_id = ${brandId}
      ORDER BY occurred_at, id
    `;
    for (const event of remainingEvents) {
      const deletionId = await this.scrubSourceEvent(
        tx,
        organizationId,
        event.id,
        event.raw_payload_ref,
        null,
        event.id === sourceEventId ? "processed" : "ignored",
      );
      rawPayloadsDeleted += deletionId ? 1 : 0;
    }
    await tx`
      UPDATE retention_integrations
      SET
        status = 'revoked',
        credential_ciphertext = NULL,
        webhook_secret_ciphertext = NULL,
        cursor = '{}'::JSONB,
        external_account_id = NULL,
        last_error_code = NULL,
        last_error_message = NULL,
        updated_at = now()
      WHERE org_id = ${organizationId}
        AND brand_id = ${brandId}
    `;
    await tx`
      UPDATE retention_migration_runs
      SET
        status = 'cancelled',
        completed_at = COALESCE(completed_at, now()),
        updated_at = now()
      WHERE org_id = ${organizationId}
        AND integration_id IN (
          SELECT id
          FROM retention_integrations
          WHERE org_id = ${organizationId}
            AND brand_id = ${brandId}
        )
        AND status IN ('preview', 'approved', 'running', 'paused')
    `;
    await tx`
      UPDATE retention_brands
      SET
        name = 'Erased brand',
        website_url = NULL,
        status = 'archived',
        metadata = '{}'::JSONB,
        updated_at = now()
      WHERE org_id = ${organizationId}
        AND id = ${brandId}
    `;
    await this.auditSystem(tx, organizationId, {
      action: "brand.privacy_erased",
      resourceType: "brand",
      resourceId: brandId,
      metadata: {
        integrationId,
        sourceEventId,
        customerCount: customers.length,
        rawPayloadsDeleted,
      },
    });
  }

  private decryptCustomerDisplayName(
    organizationId: string,
    customerId: string,
    ciphertext: string | null,
  ): string | null {
    if (!ciphertext) return null;
    try {
      return this.crypto.decrypt(
        ciphertext,
        `${organizationId}:customer:${customerId}:name`,
      );
    } catch {
      return this.crypto.decrypt(
        ciphertext,
        `${organizationId}:customer:${customerId}:display-name`,
      );
    }
  }

  private async forEachSegmentCustomerBatch(
    tx: RetentionTransactionSql,
    input: {
      organizationId: string;
      brandId: string;
      evidenceCutoff: Date;
      customerIds?: string[];
    },
    visitor: (
      customers: Array<{ customerId: string; state: SegmentCustomerState }>,
    ) => Promise<void> | void,
  ): Promise<void> {
    let lastCustomerId: string | null = null;
    while (true) {
      const customers: Array<{
        id: string;
        status: string;
        primary_email_ciphertext: string | null;
        primary_phone_ciphertext: string | null;
        created_at: Date;
        source_updated_at: Date | null;
      }> = input.customerIds
        ? await tx<
            Array<{
              id: string;
              status: string;
              primary_email_ciphertext: string | null;
              primary_phone_ciphertext: string | null;
              created_at: Date;
              source_updated_at: Date | null;
            }>
          >`
            SELECT
              id,
              status,
              primary_email_ciphertext,
              primary_phone_ciphertext,
              created_at,
              source_updated_at
            FROM retention_customers
            WHERE org_id = ${input.organizationId}
              AND brand_id = ${input.brandId}
              AND id = ANY(${tx.array(input.customerIds)}::UUID[])
              AND status = 'active'
              AND created_at <= ${input.evidenceCutoff}
              AND (${lastCustomerId}::UUID IS NULL OR id > ${lastCustomerId})
            ORDER BY id
            LIMIT 500
          `
        : await tx<
            Array<{
              id: string;
              status: string;
              primary_email_ciphertext: string | null;
              primary_phone_ciphertext: string | null;
              created_at: Date;
              source_updated_at: Date | null;
            }>
          >`
        SELECT
          id,
          status,
          primary_email_ciphertext,
          primary_phone_ciphertext,
          created_at,
          source_updated_at
        FROM retention_customers
        WHERE org_id = ${input.organizationId}
          AND brand_id = ${input.brandId}
          AND status = 'active'
          AND created_at <= ${input.evidenceCutoff}
          AND (${lastCustomerId}::UUID IS NULL OR id > ${lastCustomerId})
        ORDER BY id
        LIMIT 500
      `;
      if (customers.length === 0) break;
      const customerIds = customers.map((customer) => customer.id);
      const consentRows = await tx<
        Array<{ customer_id: string; state: string }>
      >`
        SELECT DISTINCT ON (customer_id)
          customer_id,
          state
        FROM retention_consent_events
        WHERE org_id = ${input.organizationId}
          AND brand_id = ${input.brandId}
          AND customer_id = ANY(${tx.array(customerIds)}::UUID[])
          AND channel = 'email'
          AND occurred_at <= ${input.evidenceCutoff}
        ORDER BY customer_id, occurred_at DESC, created_at DESC
      `;
      const eventRows = await tx<
        Array<{
          customer_id: string;
          provider: string;
          event_type: string;
          event_count: string;
          latest_at: Date;
        }>
      >`
        SELECT
          customer_id,
          provider,
          event_type,
          count(*)::TEXT AS event_count,
          max(occurred_at) AS latest_at
        FROM retention_source_events
        WHERE org_id = ${input.organizationId}
          AND brand_id = ${input.brandId}
          AND customer_id = ANY(${tx.array(customerIds)}::UUID[])
          AND occurred_at <= ${input.evidenceCutoff}
          AND processing_status IN ('processed', 'ignored')
        GROUP BY customer_id, provider, event_type
      `;
      const traitRows = await tx<
        Array<{
          id: string;
          customer_id: string;
          trait_key: string;
          value_ciphertext: string;
        }>
      >`
        SELECT DISTINCT ON (customer_id, trait_key)
          id,
          customer_id,
          trait_key,
          value_ciphertext
        FROM retention_customer_traits
        WHERE org_id = ${input.organizationId}
          AND brand_id = ${input.brandId}
          AND customer_id = ANY(${tx.array(customerIds)}::UUID[])
          AND observed_at <= ${input.evidenceCutoff}
          AND (expires_at IS NULL OR expires_at > ${input.evidenceCutoff})
          AND targeting_status NOT IN ('rejected', 'expired')
          AND sensitivity IN ('standard', 'personal')
        ORDER BY customer_id, trait_key, observed_at DESC, id DESC
      `;
      const consentByCustomer = new Map(
        consentRows.map((row) => [row.customer_id, row.state]),
      );
      const eventsByCustomer = new Map<
        string,
        Array<(typeof eventRows)[number]>
      >();
      for (const row of eventRows) {
        const rows = eventsByCustomer.get(row.customer_id) ?? [];
        rows.push(row);
        eventsByCustomer.set(row.customer_id, rows);
      }
      const traitsByCustomer = new Map<string, Record<string, unknown>>();
      for (const row of traitRows) {
        let value: unknown;
        try {
          value = JSON.parse(
            this.crypto.decrypt(
              row.value_ciphertext,
              `${input.organizationId}:trait:${row.id}:value`,
            ),
          );
        } catch {
          continue;
        }
        const safeValue = Array.isArray(value)
          ? value
              .map((item) => scalarForDossier(item))
              .filter((item) => item !== null)
              .slice(0, 50)
          : scalarForDossier(value);
        if (safeValue === null) continue;
        const traits = traitsByCustomer.get(row.customer_id) ?? {};
        traits[row.trait_key] = safeValue;
        traitsByCustomer.set(row.customer_id, traits);
      }

      const states: Array<{
        customerId: string;
        state: SegmentCustomerState;
      }> = [];
      for (const customer of customers) {
        const events = eventsByCustomer.get(customer.id) ?? [];
        const eventCount = events.reduce(
          (sum, row) => sum + Number(row.event_count),
          0,
        );
        const latestEventTime = events.reduce(
          (latest, row) => Math.max(latest, row.latest_at.getTime()),
          Number.NEGATIVE_INFINITY,
        );
        const state: SegmentCustomerState = {
          profile: {
            status: customer.status,
            has_email: customer.primary_email_ciphertext !== null,
            has_phone: customer.primary_phone_ciphertext !== null,
            created_at: customer.created_at.toISOString(),
            source_updated_at:
              customer.source_updated_at?.toISOString() ?? null,
          },
          consent: {
            email: consentByCustomer.get(customer.id) ?? "unknown",
          },
          metric: {
            source_event_count: eventCount,
            klaviyo_event_count: events
              .filter((row) => row.provider === "klaviyo")
              .reduce((sum, row) => sum + Number(row.event_count), 0),
            days_since_last_event: Number.isFinite(latestEventTime)
              ? Math.max(
                  0,
                  Math.floor(
                    (input.evidenceCutoff.getTime() - latestEventTime) /
                      86_400_000,
                  ),
                )
              : null,
          },
          evidence: {
            provider: [...new Set(events.map((row) => row.provider))].sort(),
            event_type: [
              ...new Set(events.map((row) => row.event_type)),
            ].sort(),
          },
          trait: traitsByCustomer.get(customer.id) ?? {},
        };
        states.push({ customerId: customer.id, state });
      }
      await visitor(states);
      lastCustomerId = customers.at(-1)!.id;
    }
  }

  private async buildSegmentDiscoverySummary(
    tx: RetentionTransactionSql,
    input: {
      organizationId: string;
      brandId: string;
      evidenceCutoff: Date;
      customerIds?: string[];
    },
  ): Promise<ReturnType<SegmentDiscoveryProfiler["summary"]>> {
    const profiler = new SegmentDiscoveryProfiler();
    await this.forEachSegmentCustomerBatch(tx, input, (customers) => {
      for (const customer of customers) profiler.observeSignals(customer.state);
    });
    profiler.prepareCombinations();
    await this.forEachSegmentCustomerBatch(tx, input, (customers) => {
      for (const customer of customers) {
        profiler.observeCombinations(customer.state);
      }
    });
    return profiler.summary();
  }

  private async evaluateSegmentMemberships(
    tx: RetentionTransactionSql,
    input: {
      organizationId: string;
      brandId: string;
      runId: string;
      evidenceCutoff: Date;
      definitions: StoredSegmentDefinition[];
    },
  ): Promise<Map<string, { memberCount: number; eligibleCount: number }>> {
    const counts = new Map(
      input.definitions.map((definition) => [
        definition.id,
        { memberCount: 0, eligibleCount: 0 },
      ]),
    );
    const cohortRows = await tx<Array<{ customer_id: string }>>`
      SELECT customer_id
      FROM retention_segment_run_cohort
      WHERE org_id = ${input.organizationId}
        AND segment_run_id = ${input.runId}
      ORDER BY selected_rank
    `;
    const cohortCustomerIds = cohortRows.map((row) => row.customer_id);
    if (cohortCustomerIds.length === 0) {
      throw new RetentionServiceError(
        "segment_run_cohort_missing",
        "The frozen campaign review cohort is unavailable.",
        409,
      );
    }
    await this.forEachSegmentCustomerBatch(
      tx,
      { ...input, customerIds: cohortCustomerIds },
      async (customers) => {
        const membershipRows: Array<{
          org_id: string;
          segment_definition_id: string;
          segment_run_id: string;
          customer_id: string;
          campaign_eligible: boolean;
          eligibility_reason: string;
          evidence_cutoff_at: Date;
        }> = [];
        for (const customer of customers) {
          const eligibility = campaignEligibility(customer.state);
          for (const definition of input.definitions) {
            if (
              !evaluateSegmentExpression(definition.expression, customer.state)
            ) {
              continue;
            }
            membershipRows.push({
              org_id: input.organizationId,
              segment_definition_id: definition.id,
              segment_run_id: input.runId,
              customer_id: customer.customerId,
              campaign_eligible: eligibility.eligible,
              eligibility_reason: eligibility.reason,
              evidence_cutoff_at: input.evidenceCutoff,
            });
            const count = counts.get(definition.id)!;
            count.memberCount += 1;
            if (eligibility.eligible) count.eligibleCount += 1;
          }
        }
        if (membershipRows.length > 0) {
          await tx`
          INSERT INTO retention_segment_memberships ${tx(
            membershipRows,
            "org_id",
            "segment_definition_id",
            "segment_run_id",
            "customer_id",
            "campaign_eligible",
            "eligibility_reason",
            "evidence_cutoff_at",
          )}
          ON CONFLICT (org_id, segment_definition_id, customer_id)
          DO UPDATE SET
            segment_run_id = excluded.segment_run_id,
            campaign_eligible = excluded.campaign_eligible,
            eligibility_reason = excluded.eligibility_reason,
            evidence_cutoff_at = excluded.evidence_cutoff_at,
            evaluated_at = now()
        `;
        }
      },
    );
    return counts;
  }

  private async auditSystem(
    tx: RetentionTransactionSql,
    organizationId: string,
    input: {
      action: string;
      resourceType: string;
      resourceId?: string;
      metadata?: unknown;
    },
  ): Promise<void> {
    await tx`
      INSERT INTO retention_audit_events (
        id,
        org_id,
        action,
        resource_type,
        resource_id,
        metadata
      )
      VALUES (
        ${randomUUID()},
        ${organizationId},
        ${input.action},
        ${input.resourceType},
        ${input.resourceId ?? null},
        ${tx.json(JSON.parse(canonicalJson(input.metadata ?? {})))}
      )
    `;
  }

  private async auditPrivacyFailure(
    context: TenantContext,
    input: {
      action: string;
      resourceType: string;
      resourceId: string;
      errorCode: string;
    },
  ): Promise<void> {
    try {
      await this.database.withTenant(context.organizationId, async (tx) => {
        await this.audit(tx, context, {
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          metadata: { errorCode: input.errorCode },
        });
      });
    } catch {
      // The original privacy operation error remains authoritative.
    }
  }

  private async enqueueJob(
    tx: RetentionTransactionSql,
    organizationId: string,
    input: {
      id: string;
      type: string;
      dedupeKey?: string;
      payload: unknown;
    },
  ): Promise<void> {
    await tx`
      INSERT INTO retention_jobs (
        id,
        org_id,
        job_type,
        dedupe_key,
        payload_ciphertext,
        max_attempts
      )
      VALUES (
        ${input.id},
        ${organizationId},
        ${input.type},
        ${input.dedupeKey ?? null},
        ${encryptedJson(
          this.crypto,
          input.payload,
          `${organizationId}:job:${input.id}:payload`,
        )},
        ${this.options.maxJobAttempts}
      )
      ON CONFLICT DO NOTHING
    `;
    await tx`
      UPDATE retention_tenant_registry
      SET last_job_at = now()
      WHERE org_id = ${organizationId}
    `;
  }

  private async audit(
    tx: RetentionTransactionSql,
    context: TenantContext,
    input: {
      action: string;
      resourceType: string;
      resourceId?: string;
      metadata?: unknown;
    },
  ): Promise<void> {
    await tx`
      INSERT INTO retention_audit_events (
        id,
        org_id,
        actor_user_id,
        assistant_id,
        action,
        resource_type,
        resource_id,
        request_id,
        metadata
      )
      VALUES (
        ${randomUUID()},
        ${context.organizationId},
        ${context.userId},
        ${context.assistantId},
        ${input.action},
        ${input.resourceType},
        ${input.resourceId ?? null},
        ${context.requestId},
        ${tx.json(JSON.parse(canonicalJson(input.metadata ?? {})))}
      )
    `;
  }
}
