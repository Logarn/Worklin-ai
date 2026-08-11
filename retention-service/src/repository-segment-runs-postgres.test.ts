import { randomUUID } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { RetentionCrypto } from "./crypto.js";
import { RetentionDatabase } from "./database.js";
import { RetentionRepository } from "./repository.js";
import type { TenantContext } from "./types.js";

const databaseUrl = process.env.RETENTION_TEST_DATABASE_URL;

function context(organizationId: string): TenantContext {
  return {
    organizationId,
    userId: "segment-reviewer",
    assistantId: "segment-assistant",
    roles: ["retention_owner"],
    permissions: [
      "retention:read",
      "retention:write",
      "retention:generate",
      "retention:approve",
    ],
    requestId: randomUUID(),
  };
}

function reviewSample(index: number) {
  return {
    customerReference: `archetype_review_${index}`,
    subject: `A useful option ${index}`,
    preheader: "A simple next step to consider",
    body: `Here is a clear way to compare the options that interested you. Start with the details that matter most before choosing option ${index}.`,
    explanation: "This version supports a current product decision.",
  };
}

describe("segment review repository with PostgreSQL", () => {
  test.skipIf(!databaseUrl)(
    "isolates tenants and excludes suppressed members from eligibility",
    async () => {
      const organizationId = randomUUID();
      const otherOrganizationId = randomUUID();
      const database = new RetentionDatabase(databaseUrl!, {
        timeoutMs: 10_000,
      });
      const crypto = new RetentionCrypto(Buffer.alloc(32, 51));
      const repository = new RetentionRepository(database, crypto, {
        maxJobAttempts: 8,
        jobLeaseSeconds: 120,
        externalWritesEnabled: false,
        sendEnabled: false,
        rawPayloadStore: {
          putEncryptedPayload: async () => "unused",
          deleteEncryptedPayload: async () => undefined,
          ready: async () => true,
        },
      });
      const owner = context(organizationId);
      const other = context(otherOrganizationId);

      try {
        expect(await database.migrationsReady()).toBe(true);
        expect(await database.tenantIsolationReady()).toBe(true);
        await repository.initializeTenant(owner);
        await repository.initializeTenant(other);
        const brand = await repository.createBrand(owner, {
          name: "Example retention brand",
        });
        const subscribedCustomerId = randomUUID();
        const suppressedCustomerId = randomUUID();
        await database.withTenant(organizationId, async (tx) => {
          for (const customerId of [
            subscribedCustomerId,
            suppressedCustomerId,
          ]) {
            await tx`
              INSERT INTO retention_customers (
                id,
                org_id,
                brand_id,
                primary_email_ciphertext
              )
              VALUES (
                ${customerId},
                ${organizationId},
                ${brand.id},
                ${crypto.encrypt(
                  `${customerId}@example.com`,
                  `${organizationId}:customer:${customerId}:email`,
                )}
              )
            `;
          }
          await tx`
            INSERT INTO retention_consent_events (
              id,
              org_id,
              brand_id,
              customer_id,
              channel,
              state,
              source_provider,
              occurred_at
            )
            VALUES
              (
                ${randomUUID()},
                ${organizationId},
                ${brand.id},
                ${subscribedCustomerId},
                'email',
                'subscribed',
                'klaviyo',
                now()
              ),
              (
                ${randomUUID()},
                ${organizationId},
                ${brand.id},
                ${suppressedCustomerId},
                'email',
                'suppressed',
                'klaviyo',
                now()
              )
          `;
        });

        await expect(
          repository.createSegmentRun(owner, {
            brandId: brand.id,
            maxSegments: 10,
            sampleLimitPerSegment: 0,
            trancheSize: 10,
          }),
        ).rejects.toEqual(
          expect.objectContaining({
            code: "invalid_sample_limit",
            status: 400,
          }),
        );

        const run = await repository.createSegmentRun(owner, {
          brandId: brand.id,
          maxSegments: 10,
          sampleLimitPerSegment: 2,
          trancheSize: 10,
        });
        const claimed = await repository.claimSegmentRun(owner, {
          runId: run.id,
        });
        expect(claimed.dossier).toMatchObject({
          version: "segment_account_dossier_v2",
          profileCoverage: {
            profilesAnalyzed: 2,
            eligibleProfiles: 1,
            allActiveProfilesIncluded: true,
          },
          behaviorCombinations: [],
        });
        const completed = await repository.completeSegmentRun(owner, {
          runId: run.id,
          leaseOwner: claimed.leaseOwner,
          outcome: "continue",
          definitions: [
            {
              name: "Reachable profiles",
              description: "Profiles containing a usable email address.",
              expression: {
                type: "predicate",
                namespace: "profile",
                key: "has_email",
                operator: "equals",
                value: true,
              },
              confidence: 1,
              evidence: ["Two normalized profiles contain email addresses."],
              campaignPreview: {
                strategy: { objective: "Review-only example" },
                qualityStatus: "passed",
                qualityIssues: [],
                modelProvider: "test",
                modelId: "test-model",
                promptVersion: "segment-pilot-v1",
                usage: { inputTokens: 10, outputTokens: 10 },
                samples: [reviewSample(1), reviewSample(2)],
              },
            },
          ],
        });
        expect(completed.status).toBe("queued");
        expect(completed.definitions[0]).toMatchObject({
          memberCount: 2,
          eligibleCount: 1,
        });
        const continuation = await repository.claimSegmentRun(owner, {
          runId: run.id,
        });
        expect(continuation.existingSegments).toEqual([
          {
            name: "Reachable profiles",
            expression: {
              type: "predicate",
              namespace: "profile",
              key: "has_email",
              operator: "equals",
              value: true,
            },
          },
        ]);
        await repository.completeSegmentRun(owner, {
          runId: run.id,
          leaseOwner: continuation.leaseOwner,
          outcome: "complete",
          definitions: [],
        });

        const listed = await repository.listSegments(owner, {
          brandId: brand.id,
        });
        expect(listed.segments).toEqual([
          expect.objectContaining({ memberCount: 2, eligibleCount: 1 }),
        ]);
        const listedForRun = await repository.listSegmentsForRun(owner, run.id);
        expect(listedForRun).toEqual({
          brandName: "Example retention brand",
          segments: listed.segments,
        });
        const definition = completed.definitions[0]!;
        expect(
          await repository.activateSegment(owner, {
            segmentId: definition.id,
            expectedVersion: definition.version,
            expectedChecksum: definition.checksum,
          }),
        ).toMatchObject({ status: "active", duplicate: false });

        const secondRun = await repository.createSegmentRun(owner, {
          brandId: brand.id,
          maxSegments: 10,
          sampleLimitPerSegment: 1,
          trancheSize: 10,
        });
        const secondClaim = await repository.claimSegmentRun(owner, {
          runId: secondRun.id,
        });
        await repository.completeSegmentRun(owner, {
          runId: secondRun.id,
          leaseOwner: secondClaim.leaseOwner,
          outcome: "complete",
          definitions: [
            {
              name: "Subscribed profiles",
              description: "Profiles with current email consent.",
              expression: {
                type: "predicate",
                namespace: "consent",
                key: "email",
                operator: "equals",
                value: "subscribed",
              },
              confidence: 1,
              evidence: ["One profile has current subscribed consent."],
              campaignPreview: {
                strategy: { objective: "Second review-only example" },
                qualityStatus: "passed",
                qualityIssues: [],
                modelProvider: "test",
                modelId: "test-model",
                promptVersion: "segment-pilot-v1",
                usage: { inputTokens: 10, outputTokens: 10 },
                samples: [reviewSample(3)],
              },
            },
          ],
        });
        expect(
          (await repository.listSegmentsForRun(owner, run.id)).segments,
        ).toEqual([
          expect.objectContaining({
            id: definition.id,
            name: "Reachable profiles",
          }),
        ]);
        expect(
          (await repository.listSegmentsForRun(owner, secondRun.id)).segments,
        ).toEqual([expect.objectContaining({ name: "Subscribed profiles" })]);
        expect(
          (await repository.listSegments(owner, { brandId: brand.id }))
            .segments,
        ).toHaveLength(2);

        await expect(repository.getSegmentRun(other, run.id)).rejects.toEqual(
          expect.objectContaining({
            code: "segment_run_not_found",
            status: 404,
          }),
        );
        await expect(
          repository.listSegmentsForRun(other, run.id),
        ).rejects.toEqual(
          expect.objectContaining({
            code: "segment_run_not_found",
            status: 404,
          }),
        );
        expect(
          (await repository.listSegments(other, { brandId: brand.id }))
            .segments,
        ).toEqual([]);
      } finally {
        await database.close();
      }
    },
  );
});
