import { randomUUID } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { RetentionCrypto } from "./crypto.js";
import { RetentionDatabase } from "./database.js";
import type { RawPayloadStore } from "./raw-payload-store.js";
import { RetentionRepository } from "./repository.js";
import {
  RetentionServiceError,
  type TenantContext,
} from "./types.js";

const databaseUrl = process.env.RETENTION_TEST_DATABASE_URL;

describe("retention operator repository with PostgreSQL", () => {
  test.skipIf(!databaseUrl)(
    "executes tenant-scoped reads, audits access, redacts PII, and cancels safely",
    async () => {
      const organizationId = randomUUID();
      const brandId = randomUUID();
      const integrationId = randomUUID();
      const migrationId = randomUUID();
      const customerId = randomUUID();
      const programId = randomUUID();
      const decisionId = randomUUID();
      const campaignId = randomUUID();
      const audienceId = randomUUID();
      const messageId = randomUUID();
      const dispatchId = randomUUID();
      const recipientId = randomUUID();
      const usageId = randomUUID();
      const deliveryEventId = randomUUID();
      const database = new RetentionDatabase(databaseUrl!, {
        timeoutMs: 10_000,
      });
      const crypto = new RetentionCrypto(Buffer.alloc(32, 11));
      const rawPayloadStore: RawPayloadStore = {
        putEncryptedPayload: async () => "source-events/example",
        deleteEncryptedPayload: async () => undefined,
        ready: async () => true,
      };
      const repository = new RetentionRepository(database, crypto, {
        maxJobAttempts: 8,
        jobLeaseSeconds: 120,
        externalWritesEnabled: false,
        sendEnabled: false,
        rawPayloadStore,
      });
      const context: TenantContext = {
        organizationId,
        userId: "user-123",
        assistantId: "assistant-123",
        roles: ["retention_marketer"],
        permissions: [
          "retention:read",
          "retention:write",
          "retention:send",
        ],
        requestId: "request-123",
      };

      try {
        expect(await database.migrationsReady()).toBe(true);
        await repository.initializeTenant(context);
        await database.withTenant(organizationId, async (tx) => {
          await tx`
            INSERT INTO retention_brands (id, org_id, name)
            VALUES (${brandId}, ${organizationId}, 'Example Brand')
          `;
          await tx`
            INSERT INTO retention_integrations (
              id,
              org_id,
              brand_id,
              provider,
              status,
              control_plane_connection_id,
              webhook_secret_ciphertext
            )
            VALUES (
              ${integrationId},
              ${organizationId},
              ${brandId},
              'shopify',
              'backfilling',
              'connection-123',
              'encrypted-secret'
            )
          `;
          await tx`
            INSERT INTO retention_migration_runs (
              id,
              org_id,
              integration_id,
              status,
              manifest,
              checkpoint,
              imported_count,
              rejected_count
            )
            VALUES (
              ${migrationId},
              ${organizationId},
              ${integrationId},
              'running',
              ${tx.json({ privateSourceManifest: true })},
              ${tx.json({ privateCursor: "cursor-123" })},
              10,
              1
            )
          `;
          await tx`
            INSERT INTO retention_customers (
              id,
              org_id,
              brand_id,
              primary_email_ciphertext,
              display_name_ciphertext
            )
            VALUES (
              ${customerId},
              ${organizationId},
              ${brandId},
              ${crypto.encrypt(
                "alice@example.com",
                `${organizationId}:customer:${customerId}:email`,
              )},
              ${crypto.encrypt(
                "Alice",
                `${organizationId}:customer:${customerId}:display-name`,
              )}
            )
          `;
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
              ${programId},
              ${organizationId},
              ${brandId},
              're_engagement',
              'Re-engagement',
              'paused',
              'v1',
              '{}'::JSONB
            )
          `;
          await tx`
            INSERT INTO retention_customer_decisions (
              id,
              org_id,
              brand_id,
              customer_id,
              program_id,
              status,
              objective,
              reasoning_ciphertext,
              evidence_event_ids,
              sensitivity,
              confidence,
              input_evidence_cutoff_at,
              reasoned_at
            )
            VALUES (
              ${decisionId},
              ${organizationId},
              ${brandId},
              ${customerId},
              ${programId},
              'eligible',
              'Help Alice return without pressure.',
              ${crypto.encrypt(
                JSON.stringify({
                  rationale:
                    "Alice at alice@example.com has verified engagement.",
                }),
                `${organizationId}:decision:${decisionId}:reasoning`,
              )},
              '{}',
              'standard',
              0.8,
              now(),
              now()
            )
          `;
          await tx`
            INSERT INTO retention_campaigns (
              id,
              org_id,
              brand_id,
              program_id,
              mode,
              name,
              status,
              created_by
            )
            VALUES (
              ${campaignId},
              ${organizationId},
              ${brandId},
              ${programId},
              'individual_message',
              'Return campaign',
              'ready_to_send',
              'user-123'
            )
          `;
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
              ${audienceId},
              ${organizationId},
              ${campaignId},
              1,
              ${"a".repeat(64)},
              1,
              0,
              now(),
              'user-123',
              now()
            )
          `;
          await tx`
            INSERT INTO retention_audience_members (
              org_id,
              audience_snapshot_id,
              customer_id,
              decision_id,
              inclusion_explanation_ciphertext,
              consent_state
            )
            VALUES (
              ${organizationId},
              ${audienceId},
              ${customerId},
              ${decisionId},
              ${crypto.encrypt(
                "Alice qualified from verified engagement.",
                `${organizationId}:audience:${audienceId}:customer:${customerId}:explanation`,
              )},
              'subscribed'
            )
          `;
          await tx`
            INSERT INTO retention_rendered_messages (
              id,
              org_id,
              campaign_id,
              customer_id,
              subject_ciphertext,
              body_ciphertext,
              explanation_ciphertext,
              message_sha256,
              model_provider,
              model_id,
              prompt_version,
              quality_status,
              generated_at
            )
            VALUES (
              ${messageId},
              ${organizationId},
              ${campaignId},
              ${customerId},
              ${crypto.encrypt(
                "Hello Alice",
                `${organizationId}:message:${messageId}:subject`,
              )},
              ${crypto.encrypt(
                "Alice, this was prepared for alice@example.com.",
                `${organizationId}:message:${messageId}:body`,
              )},
              ${crypto.encrypt(
                "Verified engagement",
                `${organizationId}:message:${messageId}:explanation`,
              )},
              ${"b".repeat(64)},
              'example',
              'example-model',
              'v1',
              'passed',
              now()
            )
          `;
          await tx`
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
              ${organizationId},
              ${campaignId},
              'klaviyo',
              'idempotency-key-123456',
              ${"c".repeat(64)},
              'pending',
              1,
              'user-123',
              now()
            )
          `;
          await tx`
            INSERT INTO retention_dispatch_recipients (
              id,
              org_id,
              dispatch_id,
              campaign_id,
              customer_id,
              opaque_recipient_id,
              status
            )
            VALUES (
              ${recipientId},
              ${organizationId},
              ${dispatchId},
              ${campaignId},
              ${customerId},
              'opaque-recipient-123',
              'pending'
            )
          `;
          await tx`
            INSERT INTO retention_usage_events (
              id,
              org_id,
              campaign_id,
              purpose,
              provider,
              model,
              input_tokens,
              output_tokens,
              estimated_cost_usd
            )
            VALUES (
              ${usageId},
              ${organizationId},
              ${campaignId},
              'message_generation',
              'example',
              'example-model',
              100,
              50,
              0.25
            )
          `;
          await tx`
            INSERT INTO retention_delivery_events (
              id,
              org_id,
              dispatch_id,
              campaign_id,
              customer_id,
              provider_event_id,
              event_type,
              occurred_at
            )
            VALUES (
              ${deliveryEventId},
              ${organizationId},
              ${dispatchId},
              ${campaignId},
              ${customerId},
              'provider-event-123',
              'clicked',
              now()
            )
          `;
        });

        const imports = await repository.reviewImports(context, {
          limit: 10,
        });
        expect(imports.imports).toHaveLength(1);
        expect(JSON.stringify(imports)).not.toContain("privateCursor");
        expect(JSON.stringify(imports)).not.toContain(
          "privateSourceManifest",
        );

        const explanation = await repository.explainCustomer(context, {
          customerId,
        });
        expect(explanation.customerReference).not.toContain(customerId);
        expect(explanation.currentDecision?.rationale).toContain(
          "[redacted identifier]",
        );
        expect(JSON.stringify(explanation)).not.toContain(
          "alice@example.com",
        );

        const campaigns = await repository.listCampaigns(context, {
          limit: 10,
        });
        expect(campaigns.campaigns[0]?.audienceMemberCount).toBe(1);

        const audience = await repository.previewAudience(context, {
          audienceSnapshotId: audienceId,
          sampleLimit: 10,
        });
        expect(audience.samples[0]?.inclusionExplanation).not.toContain(
          "Alice",
        );

        const campaign = await repository.previewCampaign(context, {
          campaignId,
          sampleLimit: 10,
        });
        expect(campaign.messageSamples[0]?.subject).toBe(
          "Hello [redacted identifier]",
        );
        expect(campaign.messageSamples[0]?.body).not.toContain(
          "alice@example.com",
        );

        const outcomes = await repository.analyzeCampaignOutcomes(
          context,
          campaignId,
        );
        expect(outcomes.deliveryEvents).toEqual({ clicked: 1 });
        expect(outcomes.usage.estimatedCostUsd).toBe(0.25);

        const otherTenantContext = {
          ...context,
          organizationId: randomUUID(),
          requestId: "request-other-tenant",
        };
        expect(
          (
            await repository.listCampaigns(otherTenantContext, {
              limit: 10,
            })
          ).campaigns,
        ).toEqual([]);
        try {
          await repository.explainCustomer(otherTenantContext, {
            customerId,
          });
          throw new Error("Expected cross-tenant lookup to fail.");
        } catch (error) {
          expect(error).toBeInstanceOf(RetentionServiceError);
          expect((error as RetentionServiceError).code).toBe(
            "customer_not_found",
          );
        }
        try {
          await repository.cancelCampaign(otherTenantContext, {
            campaignId,
            reason: "Cross-tenant cancellation attempt.",
          });
          throw new Error("Expected cross-tenant cancellation to fail.");
        } catch (error) {
          expect(error).toBeInstanceOf(RetentionServiceError);
          expect((error as RetentionServiceError).code).toBe(
            "campaign_not_found",
          );
        }

        const cancelled = await repository.cancelCampaign(context, {
          campaignId,
          reason: "The campaign objective changed.",
        });
        expect(cancelled.cancelledDispatchCount).toBe(1);
        expect(cancelled.cancelledRecipientCount).toBe(1);

        const auditRows = await database.withTenant(
          organizationId,
          async (tx) => tx<Array<{ action: string }>>`
            SELECT action
            FROM retention_audit_events
            WHERE org_id = ${organizationId}
            ORDER BY created_at, id
          `,
        );
        expect(auditRows.map((row) => row.action)).toEqual(
          expect.arrayContaining([
            "imports.reviewed",
            "customer.explanation_viewed",
            "campaigns.listed",
            "audience.previewed",
            "campaign.previewed",
            "campaign.outcomes_viewed",
            "campaign.cancelled",
          ]),
        );
      } finally {
        await database.close();
      }
    },
  );
});
