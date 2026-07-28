import { randomUUID } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { RetentionCrypto } from "./crypto.js";
import { RetentionDatabase } from "./database.js";
import {
  rawPayloadReference,
  type RawPayloadStore,
} from "./raw-payload-store.js";
import {
  type ProviderSyncJobPayload,
  RetentionRepository,
} from "./repository.js";
import type { TenantContext } from "./types.js";

const databaseUrl = process.env.RETENTION_TEST_DATABASE_URL;

function shopifyCustomer() {
  return {
    id: "gid://shopify/Customer/1001",
    firstName: "Alice",
    lastName: "Example",
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    numberOfOrders: 2,
    amountSpent: { amount: "145.50", currencyCode: "USD" },
    defaultEmailAddress: { emailAddress: "alice@example.com" },
    defaultPhoneNumber: { phoneNumber: "+1-202-555-0100" },
    emailMarketingConsent: {
      marketingState: "SUBSCRIBED",
      consentUpdatedAt: "2026-07-01T10:00:00.000Z",
    },
  };
}

describe("provider synchronization with PostgreSQL", () => {
  test.skipIf(!databaseUrl)(
    "requires import approval and checkpoints authenticated read pages",
    async () => {
      const organizationId = randomUUID();
      const database = new RetentionDatabase(databaseUrl!, {
        timeoutMs: 10_000,
      });
      const crypto = new RetentionCrypto(Buffer.alloc(32, 23));
      const rawPayloadWrites: string[] = [];
      let holdRawPayloadWrite = false;
      let signalRawPayloadWriteStarted: () => void = () => {};
      let releaseRawPayloadWrite: () => void = () => {};
      const rawPayloadWriteStarted = new Promise<void>((resolve) => {
        signalRawPayloadWriteStarted = resolve;
      });
      const rawPayloadWriteGate = new Promise<void>((resolve) => {
        releaseRawPayloadWrite = resolve;
      });
      const rawPayloadStore: RawPayloadStore = {
        putEncryptedPayload: async (input) => {
          if (holdRawPayloadWrite) {
            signalRawPayloadWriteStarted();
            await rawPayloadWriteGate;
          }
          const reference = rawPayloadReference(input);
          rawPayloadWrites.push(reference);
          return reference;
        },
        deleteEncryptedPayload: async () => undefined,
        ready: async () => true,
      };
      const providerRequests: string[] = [];
      const repository = new RetentionRepository(database, crypto, {
        maxJobAttempts: 8,
        jobLeaseSeconds: 120,
        externalWritesEnabled: false,
        sendEnabled: false,
        rawPayloadStore,
        providerFetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as { query: string };
          const resource = body.query.includes("RetentionCustomers")
            ? "customers"
            : "orders";
          providerRequests.push(resource);
          return Response.json({
            data: {
              [resource]: {
                nodes: resource === "customers" ? [shopifyCustomer()] : [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
            extensions: {
              cost: {
                requestedQueryCost: 10,
                actualQueryCost: 5,
                throttleStatus: {
                  maximumAvailable: 1_000,
                  currentlyAvailable: 995,
                  restoreRate: 50,
                },
              },
            },
          });
        },
      });
      const context: TenantContext = {
        organizationId,
        userId: "integration-owner",
        assistantId: "integration-assistant",
        roles: ["retention_owner"],
        permissions: [
          "retention:read",
          "retention:write",
          "retention:integrations",
        ],
        requestId: randomUUID(),
      };
      const workerId = "provider-sync-postgres-test";

      try {
        expect(await database.migrationsReady()).toBe(true);
        await repository.initializeTenant(context);
        const brand = await repository.createBrand(context, {
          name: "Provider Sync Test",
        });
        const integration = await repository.createIntegration(context, {
          brandId: brand.id,
          provider: "shopify",
          controlPlaneConnectionId: randomUUID(),
          externalAccountId: "example-shop.myshopify.com",
          credential: "shopify-access-token",
          webhookSecret: "shopify-webhook-secret",
        });
        const preview = await repository.reviewImports(context, {
          integrationId: integration.id,
          limit: 10,
        });
        expect(preview.imports).toEqual([
          expect.objectContaining({
            id: integration.migrationRunId,
            status: "preview",
            provider: "shopify",
          }),
        ]);

        await repository.approveImport(context, {
          migrationRunId: integration.migrationRunId,
        });
        for (let index = 0; index < 2; index += 1) {
          await repository.scheduleTenantSyncs(organizationId);
          const job = await repository.claimJob(
            organizationId,
            workerId,
            ["sync_provider_page"],
          );
          expect(job).not.toBeNull();
          await repository.processProviderSyncPage(
            organizationId,
            job!.payload as ProviderSyncJobPayload,
          );
          await repository.completeJob(
            organizationId,
            workerId,
            job!.id,
          );
        }
        await repository.scheduleTenantSyncs(organizationId);
        expect(
          await repository.claimJob(organizationId, workerId, [
            "sync_provider_page",
          ]),
        ).toBeNull();
        const persistenceJob = await repository.claimJob(
          organizationId,
          workerId,
          ["persist_raw_payload"],
        );
        expect(persistenceJob).not.toBeNull();
        const persistenceEventId = String(
          (persistenceJob!.payload as { eventId: string }).eventId,
        );
        holdRawPayloadWrite = true;
        const persistence = repository.processRawPayloadPersistence(
          organizationId,
          persistenceEventId,
        );
        await rawPayloadWriteStarted;
        const competingLock = database.withTenant(
          organizationId,
          async (tx) => {
            await tx`
              SELECT id
              FROM retention_source_events
              WHERE org_id = ${organizationId}
                AND id = ${persistenceEventId}
              FOR UPDATE
            `;
            return "acquired" as const;
          },
        );
        const lockBeforeWriteFinished = await Promise.race([
          competingLock,
          Bun.sleep(50).then(() => "blocked" as const),
        ]);
        expect(lockBeforeWriteFinished).toBe("blocked");
        releaseRawPayloadWrite();
        await persistence;
        expect(await competingLock).toBe("acquired");
        await repository.completeJob(
          organizationId,
          workerId,
          persistenceJob!.id,
        );
        const normalizationJob = await repository.claimJob(
          organizationId,
          workerId,
          ["normalize_source_event"],
        );
        expect(normalizationJob).not.toBeNull();
        await repository.processSourceEvent(
          organizationId,
          String(
            (normalizationJob!.payload as { eventId: string }).eventId,
          ),
        );
        await repository.completeJob(
          organizationId,
          workerId,
          normalizationJob!.id,
        );

        const state = await database.withTenant(
          organizationId,
          async (tx) => {
            const integrations = await tx<
              Array<{
                status: string;
                last_webhook_at: Date | null;
                last_polled_at: Date | null;
                last_reconciled_at: Date | null;
              }>
            >`
              SELECT
                status,
                last_webhook_at,
                last_polled_at,
                last_reconciled_at
              FROM retention_integrations
              WHERE org_id = ${organizationId}
                AND id = ${integration.id}
            `;
            const migrations = await tx<
              Array<{ status: string; imported_count: string }>
            >`
              SELECT status, imported_count::TEXT
              FROM retention_migration_runs
              WHERE org_id = ${organizationId}
                AND id = ${integration.migrationRunId}
            `;
            const events = await tx<
              Array<{ signature_verified: boolean }>
            >`
              SELECT signature_verified
              FROM retention_source_events
              WHERE org_id = ${organizationId}
                AND integration_id = ${integration.id}
            `;
            const customers = await tx<Array<{ count: string }>>`
              SELECT count(*)::TEXT AS count
              FROM retention_customers
              WHERE org_id = ${organizationId}
                AND brand_id = ${brand.id}
                AND status = 'active'
            `;
            return {
              integration: integrations[0]!,
              migration: migrations[0]!,
              events: events.map((event) => ({
                signature_verified: event.signature_verified,
              })),
              customerCount: Number(customers[0]?.count ?? 0),
            };
          },
        );

        expect(providerRequests.sort()).toEqual([
          "customers",
          "orders",
        ]);
        expect(state.integration).toMatchObject({
          status: "active",
          last_webhook_at: null,
        });
        expect(state.integration.last_polled_at).toBeInstanceOf(Date);
        expect(state.integration.last_reconciled_at).toBeInstanceOf(Date);
        expect(state.migration).toEqual({
          status: "completed",
          imported_count: "1",
        });
        expect(state.events).toEqual([{ signature_verified: false }]);
        expect(state.customerCount).toBe(1);
        expect(rawPayloadWrites).toHaveLength(1);
      } finally {
        await database.close();
      }
    },
  );
});
