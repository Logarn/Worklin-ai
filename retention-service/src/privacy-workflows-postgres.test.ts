import { randomUUID } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { RetentionCrypto } from "./crypto.js";
import { RetentionDatabase } from "./database.js";
import type { RawPayloadStore } from "./raw-payload-store.js";
import { RetentionRepository } from "./repository.js";
import { RetentionServiceError, type TenantContext } from "./types.js";

const databaseUrl = process.env.RETENTION_TEST_DATABASE_URL;

describe("retention privacy workflows with PostgreSQL", () => {
  test.skipIf(!databaseUrl)(
    "isolates access, correction, deletion, tombstones, consent, and revocation",
    async () => {
      const organizationA = randomUUID();
      const organizationB = randomUUID();
      const database = new RetentionDatabase(databaseUrl!, {
        timeoutMs: 10_000,
      });
      const crypto = new RetentionCrypto(Buffer.alloc(32, 31));
      const deletedRawPayloads: string[] = [];
      const rawPayloadStore: RawPayloadStore = {
        putEncryptedPayload: async (input) =>
          `source-events/${input.organizationId}/${input.integrationId}/${input.eventId}`,
        deleteEncryptedPayload: async (reference) => {
          deletedRawPayloads.push(reference);
        },
        ready: async () => true,
      };
      const repository = new RetentionRepository(database, crypto, {
        maxJobAttempts: 8,
        jobLeaseSeconds: 120,
        externalWritesEnabled: false,
        sendEnabled: false,
        rawPayloadStore,
      });
      const context = (organizationId: string): TenantContext => ({
        organizationId,
        userId: "privacy-user",
        assistantId: "privacy-assistant",
        roles: ["retention_marketer"],
        permissions: [
          "retention:read",
          "retention:write",
          "retention:integrations",
        ],
        requestId: randomUUID(),
      });
      const contextA = context(organizationA);
      const contextB = context(organizationB);

      try {
        expect(await database.migrationsReady()).toBe(true);
        await repository.initializeTenant(contextA);
        await repository.initializeTenant(contextB);
        const brandA = await repository.createBrand(contextA, {
          name: "Example Brand A",
        });
        const brandB = await repository.createBrand(contextB, {
          name: "Example Brand B",
        });
        const integrationA = await repository.createIntegration(contextA, {
          brandId: brandA.id,
          provider: "shopify",
          controlPlaneConnectionId: randomUUID(),
          credential: "tenant-a-credential",
          webhookSecret: "tenant-a-webhook-secret",
        });
        const integrationB = await repository.createIntegration(contextB, {
          brandId: brandB.id,
          provider: "shopify",
          controlPlaneConnectionId: randomUUID(),
          credential: "tenant-b-credential",
          webhookSecret: "tenant-b-webhook-secret",
        });
        const sourceA = await repository.appendSourceEvent(organizationA, {
          integrationId: integrationA.id,
          provider: "shopify",
          externalEventId: randomUUID(),
          eventType: "customers/update",
          occurredAt: new Date().toISOString(),
          customerExternalId: "shared-provider-customer",
          payload: {
            customer: {
              externalId: "shared-provider-customer",
              email: "user@example.com",
              displayName: "Example User",
            },
            consent: { channel: "email", state: "subscribed" },
            source: { topic: "customers/update" },
          },
          signatureVerified: true,
        });
        const processedA = await repository.processSourceEvent(
          organizationA,
          sourceA.id,
        );
        const customerA = processedA.customerId!;

        const access = await repository.customerPrivacyAccess(
          contextA,
          customerA,
        );
        expect(access.profile).toEqual({
          email: "user@example.com",
          phone: null,
          displayName: "Example User",
        });
        const consent = await repository.customerConsentHistory(contextA, {
          customerId: customerA,
          limit: 100,
        });
        expect(consent.events).toHaveLength(1);
        expect(consent.events[0]?.state).toBe("subscribed");

        try {
          await repository.exportCustomerData(contextB, customerA);
          throw new Error("Expected cross-tenant export to fail.");
        } catch (error) {
          expect(error).toBeInstanceOf(RetentionServiceError);
          expect((error as RetentionServiceError).code).toBe(
            "customer_not_found",
          );
        }

        const corrected = await repository.correctCustomer(contextA, {
          customerId: customerA,
          email: "corrected@example.com",
          displayName: "Corrected User",
          reason: "Verified customer correction.",
        });
        expect(corrected.changedFields).toEqual(["email", "displayName"]);
        const exported = await repository.exportCustomerData(
          contextA,
          customerA,
        );
        expect(
          exported.customer as {
            email: string;
            displayName: string;
          },
        ).toMatchObject({
          email: "corrected@example.com",
          displayName: "Corrected User",
        });

        const deleted = await repository.deleteCustomer(contextA, {
          customerId: customerA,
          idempotencyKey: "privacy-postgres-request-0001",
          reason: "Verified customer deletion.",
        });
        const replay = await repository.deleteCustomer(contextA, {
          customerId: customerA,
          idempotencyKey: "privacy-postgres-request-0001",
          reason: "Verified customer deletion.",
        });
        expect(deleted.duplicate).toBe(false);
        expect(deleted.rawPayloadsDeleted).toBe(1);
        expect(replay.duplicate).toBe(true);
        expect(deletedRawPayloads).toHaveLength(1);

        const blockedSource = await repository.appendSourceEvent(
          organizationA,
          {
            integrationId: integrationA.id,
            provider: "shopify",
            externalEventId: randomUUID(),
            eventType: "customers/update",
            occurredAt: new Date().toISOString(),
            customerExternalId: "shared-provider-customer",
            payload: {
              customer: {
                externalId: "shared-provider-customer",
                email: "corrected@example.com",
              },
              source: { topic: "customers/update" },
            },
            signatureVerified: true,
          },
        );
        const blocked = await repository.processSourceEvent(
          organizationA,
          blockedSource.id,
        );
        expect(blocked).toMatchObject({
          customerId: customerA,
          status: "ignored",
          reasonJobs: 0,
        });

        const sourceB = await repository.appendSourceEvent(organizationB, {
          integrationId: integrationB.id,
          provider: "shopify",
          externalEventId: randomUUID(),
          eventType: "customers/update",
          occurredAt: new Date().toISOString(),
          customerExternalId: "shared-provider-customer",
          payload: {
            customer: {
              externalId: "shared-provider-customer",
              email: "corrected@example.com",
            },
            source: { topic: "customers/update" },
          },
          signatureVerified: true,
        });
        const processedB = await repository.processSourceEvent(
          organizationB,
          sourceB.id,
        );
        expect(processedB.status).toBe("processed");
        expect(processedB.customerId).not.toBe(customerA);

        const revoked = await repository.revokeIntegration(contextA, {
          integrationId: integrationA.id,
          reason: "Owner disconnected the integration.",
        });
        const revokedAgain = await repository.revokeIntegration(contextA, {
          integrationId: integrationA.id,
          reason: "Owner disconnected the integration.",
        });
        expect(revoked.duplicate).toBe(false);
        expect(revokedAgain.duplicate).toBe(true);
        const credentials = await database.withTenant(
          organizationA,
          async (tx) => tx<
            Array<{
              credential_ciphertext: string | null;
              webhook_secret_ciphertext: string | null;
            }>
          >`
            SELECT credential_ciphertext, webhook_secret_ciphertext
            FROM retention_integrations
            WHERE org_id = ${organizationA}
              AND id = ${integrationA.id}
          `,
        );
        expect(credentials[0]).toEqual({
          credential_ciphertext: null,
          webhook_secret_ciphertext: null,
        });

        const otherTenantTombstones = await database.withTenant(
          organizationB,
          async (tx) => tx<Array<{ count: string }>>`
            SELECT count(*)::TEXT AS count
            FROM retention_customer_erasure_tombstones
            WHERE org_id = ${organizationB}
          `,
        );
        expect(otherTenantTombstones[0]?.count).toBe("0");
      } finally {
        await database.close();
      }
    },
  );
});
