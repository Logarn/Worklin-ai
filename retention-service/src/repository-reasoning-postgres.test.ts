import { randomUUID } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { RetentionCrypto } from "./crypto.js";
import { RetentionDatabase } from "./database.js";
import type { RawPayloadStore } from "./raw-payload-store.js";
import { RetentionRepository } from "./repository.js";
import type { TenantContext } from "./types.js";

const databaseUrl = process.env.RETENTION_TEST_DATABASE_URL;

describe("recipient reasoning leases with PostgreSQL", () => {
  test.skipIf(!databaseUrl)(
    "claims a bounded dossier and atomically completes its exact job",
    async () => {
      const organizationId = randomUUID();
      const otherOrganizationId = randomUUID();
      const database = new RetentionDatabase(databaseUrl!, {
        timeoutMs: 10_000,
      });
      const crypto = new RetentionCrypto(Buffer.alloc(32, 17));
      const rawPayloadStore: RawPayloadStore = {
        putEncryptedPayload: async (input) =>
          `source-events/${input.organizationId}/${input.eventId}`,
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
        userId: "reasoning-user",
        assistantId: "reasoning-assistant",
        roles: ["retention_marketer"],
        permissions: [
          "retention:read",
          "retention:write",
          "retention:generate",
          "retention:approve",
        ],
        requestId: randomUUID(),
      };

      try {
        expect(await database.migrationsReady()).toBe(true);
        await repository.initializeTenant(context);
        const brand = await repository.createBrand(context, {
          name: "Reasoning Test",
        });
        const program = await repository.createProgram(context, {
          brandId: brand.id,
          type: "re_engagement",
          name: "Re-engagement",
          policyVersion: "v1",
          policy: { objective: "Earn a useful return visit." },
        });
        const policyPreview = await repository.programPolicyApprovalPreview(
          context,
          program.id,
          brand.id,
        );
        await expect(
          repository.activateProgram(context, {
            programId: program.id,
            brandId: brand.id,
            expectedPolicySha256: "0".repeat(64),
          }),
        ).rejects.toThrow("changed before activation");
        const activated = await repository.activateProgram(context, {
          programId: program.id,
          brandId: brand.id,
          expectedPolicySha256: policyPreview.snapshotSha256,
          note: "Policy reviewed for the PostgreSQL acceptance test.",
        });
        expect(activated).toMatchObject({
          status: "active",
          duplicate: false,
          snapshotSha256: policyPreview.snapshotSha256,
        });
        expect(
          await repository.activateProgram(context, {
            programId: program.id,
            brandId: brand.id,
            expectedPolicySha256: policyPreview.snapshotSha256,
          }),
        ).toMatchObject({ status: "active", duplicate: true });
        const integration = await repository.createIntegration(context, {
          brandId: brand.id,
          provider: "shopify",
          controlPlaneConnectionId: randomUUID(),
          credential: "encrypted-at-rest",
          webhookSecret: "webhook-secret",
        });
        const source = await repository.appendSourceEvent(organizationId, {
          integrationId: integration.id,
          provider: "shopify",
          externalEventId: randomUUID(),
          eventType: "customers/update",
          occurredAt: new Date().toISOString(),
          customerExternalId: "shopify-customer-1",
          payload: {
            customer: {
              externalId: "shopify-customer-1",
              email: "person@example.com",
              displayName: "Taylor",
            },
            consent: { channel: "email", state: "subscribed" },
            traits: [
              {
                key: "product_interest",
                value: "running",
                evidenceKind: "observed",
                sensitivity: "standard",
                confidence: 0.8,
              },
              {
                key: "health_condition",
                value: "guessed",
                evidenceKind: "imported",
                sensitivity: "sensitive",
                confidence: 0.2,
              },
            ],
            source: { topic: "customers/update" },
          },
          signatureVerified: true,
        });
        await repository.processSourceEvent(organizationId, source.id);

        const other = await repository.claimRecipientReasoning({
          ...context,
          organizationId: otherOrganizationId,
        });
        expect(other).toBeNull();

        const claimed = await repository.claimRecipientReasoning(context);
        expect(claimed).not.toBeNull();
        expect(claimed?.dossier.displayName).toBe("Taylor");
        expect(claimed?.dossier.traits.map((trait) => trait.key)).toEqual([
          "product_interest",
        ]);
        expect(claimed?.dossier.recentEvents[0]?.id).toBe(source.id);
        await database.withTenant(organizationId, async (tx) => {
          await tx`
            UPDATE retention_jobs
            SET lease_expires_at = now() - interval '1 second'
            WHERE org_id = ${organizationId}
              AND id = ${claimed!.jobId}
          `;
        });
        const reclaimed = await repository.claimRecipientReasoning(context);
        expect(reclaimed?.jobId).toBe(claimed?.jobId);
        expect(reclaimed?.leaseOwner).not.toBe(claimed?.leaseOwner);

        await expect(
          repository.recordRecipientDecision(context, {
            jobId: claimed!.jobId,
            leaseOwner: claimed!.leaseOwner,
            decisionId: claimed!.decisionId,
            customerId: claimed!.customerId,
            programId: claimed!.programId,
            status: "eligible",
            dossierSha256: claimed!.dossierSha256,
            objective: "Help this customer make a useful return visit.",
            rationale: "Recent declared interest supports a relevant message.",
            recommendation: {
              action: "send_helpful_education",
              channel: "email",
              personalizationBrief:
                "Use the observed product interest without implying private facts.",
            },
            hypotheses: [],
            evidenceIds: [source.id],
            confidence: 0.7,
            sensitivity: "standard",
            requiresHumanReview: false,
            model: {
              provider: "test",
              id: "test-model",
              promptVersion: "v1",
            },
            generatedAt: new Date().toISOString(),
            evidenceCutoffAt: claimed!.dossier.evidenceCutoffAt,
          }),
        ).rejects.toThrow("lease expired");

        await expect(
          repository.recordRecipientDecision(context, {
            jobId: reclaimed!.jobId,
            leaseOwner: reclaimed!.leaseOwner,
            decisionId: reclaimed!.decisionId,
            customerId: reclaimed!.customerId,
            programId: reclaimed!.programId,
            status: "eligible",
            dossierSha256: "0".repeat(64),
            objective: "Help this customer make a useful return visit.",
            rationale: "Recent declared interest supports a relevant message.",
            recommendation: {
              action: "send_helpful_education",
              channel: "email",
              personalizationBrief:
                "Use the observed product interest without implying private facts.",
            },
            hypotheses: [],
            evidenceIds: [source.id],
            confidence: 0.7,
            sensitivity: "standard",
            requiresHumanReview: false,
            model: {
              provider: "test",
              id: "test-model",
              promptVersion: "v1",
            },
            generatedAt: new Date().toISOString(),
            evidenceCutoffAt: reclaimed!.dossier.evidenceCutoffAt,
          }),
        ).rejects.toThrow("evidence changed");

        const completed = await repository.recordRecipientDecision(context, {
          jobId: reclaimed!.jobId,
          leaseOwner: reclaimed!.leaseOwner,
          decisionId: reclaimed!.decisionId,
          customerId: reclaimed!.customerId,
          programId: reclaimed!.programId,
          status: "eligible",
          dossierSha256: reclaimed!.dossierSha256,
          objective: "Help this customer make a useful return visit.",
          rationale: "Recent declared interest supports a relevant message.",
          recommendation: {
            action: "send_helpful_education",
            channel: "email",
            personalizationBrief:
              "Use the observed product interest without implying private facts.",
          },
          hypotheses: [],
          evidenceIds: [source.id],
          confidence: 0.7,
          sensitivity: "standard",
          requiresHumanReview: false,
          model: {
            provider: "test",
            id: "test-model",
            promptVersion: "v1",
          },
          generatedAt: new Date().toISOString(),
          evidenceCutoffAt: reclaimed!.dossier.evidenceCutoffAt,
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cachedInputTokens: 20,
            estimatedProviderCost: 0.01,
          },
        });
        expect(completed).toEqual({
          decisionId: reclaimed!.decisionId,
          status: "eligible",
        });
        expect(await repository.claimRecipientReasoning(context)).toBeNull();

        const campaign = await repository.createCampaign(context, {
          brandId: brand.id,
          programId: program.id,
          mode: "individual_message",
          name: "Quality gate acceptance",
        });
        await repository.freezeCampaignAudience(context, {
          campaignId: campaign.id,
          definitionVersion: 1,
          evidenceCutoffAt: new Date().toISOString(),
          members: [
            {
              customerId: reclaimed!.customerId,
              decisionId: reclaimed!.decisionId,
              inclusionExplanation:
                "Included from the current eligible recipient decision.",
            },
          ],
        });
        await repository.prepareCampaignGeneration(context, {
          campaignId: campaign.id,
          strategy: {
            objective: "Earn a useful return visit.",
            approvedOffer: "20% off the next order",
            proof: "Used by 2,500 customers",
          },
          strategyVersion: "strategy-v1",
          modelProvider: "test",
          modelId: "test-model",
          promptVersion: "message-v1",
          estimatedMaxCostUsd: 0.1,
        });
        const blocked = await repository.recordRenderedMessage(context, {
          campaignId: campaign.id,
          customerId: reclaimed!.customerId,
          subject: "Enjoy 40% off today",
          body: "Join 9,000 customers and take 40% off this useful collection today.",
          explanation: "A fabricated claim should be rejected.",
          modelProvider: "test",
          modelId: "test-model",
          promptVersion: "message-v1",
          generatedAt: new Date().toISOString(),
          usage: {
            inputTokens: 100,
            outputTokens: 40,
            estimatedCostUsd: 0.01,
          },
        });
        expect(blocked).toMatchObject({
          campaignStatus: "generating",
          qualityStatus: "blocked",
        });
        expect(blocked.qualityIssueCodes).toContain(
          "unsupported_numeric_claim",
        );

        const accepted = await repository.recordRenderedMessage(context, {
          campaignId: campaign.id,
          customerId: reclaimed!.customerId,
          subject: "Enjoy 20% off today",
          body: "Join 2,500 customers and take 20% off this useful collection today.",
          offer: "20% off the next order",
          explanation: "Every numeric claim comes from the frozen strategy.",
          modelProvider: "test",
          modelId: "test-model",
          promptVersion: "message-v1",
          generatedAt: new Date().toISOString(),
          usage: {
            inputTokens: 100,
            outputTokens: 40,
            estimatedCostUsd: 0.01,
          },
        });
        expect(accepted).toMatchObject({
          campaignStatus: "review_required",
          qualityStatus: "passed",
          qualityIssueCodes: [],
        });
      } finally {
        await database.close();
      }
    },
  );
});
