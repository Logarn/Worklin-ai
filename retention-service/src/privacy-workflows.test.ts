import { describe, expect, test } from "bun:test";

import { RetentionCrypto } from "./crypto.js";
import type { RetentionDatabase, RetentionTransactionSql } from "./database.js";
import type { RawPayloadStore } from "./raw-payload-store.js";
import { RetentionRepository } from "./repository.js";
import type { TenantContext } from "./types.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const brandId = "22222222-2222-4222-8222-222222222222";
const customerId = "33333333-3333-4333-8333-333333333333";
const integrationId = "44444444-4444-4444-8444-444444444444";
const sourceEventId = "55555555-5555-4555-8555-555555555555";

const context: TenantContext = {
  organizationId,
  userId: "user-123",
  assistantId: "assistant-123",
  roles: ["retention_marketer"],
  permissions: ["retention:read", "retention:write", "retention:integrations"],
  requestId: "request-123",
};

interface RecordedQuery {
  sql: string;
  values: unknown[];
}

function createRepository(input: {
  resolve: (query: RecordedQuery) => unknown[];
  deletedRawPayloads?: string[];
}): {
  repository: RetentionRepository;
  crypto: RetentionCrypto;
  queries: RecordedQuery[];
  tenantContexts: string[];
} {
  const queries: RecordedQuery[] = [];
  const tenantContexts: string[] = [];
  const rawPayloadDeletions = new Map<
    string,
    {
      privacyRequestId: string | null;
      reference: string;
      status: "pending" | "deleted";
    }
  >();
  const crypto = new RetentionCrypto(Buffer.alloc(32, 21));
  const transaction = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = {
        sql: strings.join("?").replace(/\s+/gu, " ").trim(),
        values,
      };
      queries.push(query);
      if (query.sql.startsWith("INSERT INTO retention_raw_payload_deletions")) {
        rawPayloadDeletions.set(String(values[0]), {
          privacyRequestId: typeof values[3] === "string" ? values[3] : null,
          reference: String(values[4]),
          status: "pending",
        });
        return [];
      }
      if (
        query.sql.startsWith("SELECT id") &&
        query.sql.includes("FROM retention_raw_payload_deletions")
      ) {
        const privacyRequestId = String(values[1]);
        return [...rawPayloadDeletions.entries()]
          .filter(
            ([, deletion]) => deletion.privacyRequestId === privacyRequestId,
          )
          .map(([id]) => ({ id }));
      }
      if (
        query.sql.startsWith("SELECT raw_payload_ref, status") &&
        query.sql.includes("FROM retention_raw_payload_deletions")
      ) {
        const deletion = rawPayloadDeletions.get(String(values[1]));
        return deletion
          ? [
              {
                raw_payload_ref: deletion.reference,
                status: deletion.status,
              },
            ]
          : [];
      }
      if (
        query.sql.startsWith("UPDATE retention_raw_payload_deletions") &&
        query.sql.includes("status = 'deleted'")
      ) {
        const deletion = rawPayloadDeletions.get(String(values[1]));
        if (deletion) deletion.status = "deleted";
        return [];
      }
      if (
        query.sql.startsWith("SELECT count(*)::TEXT AS count") &&
        query.sql.includes("FROM retention_raw_payload_deletions")
      ) {
        const privacyRequestId = String(values[1]);
        const count = [...rawPayloadDeletions.values()].filter(
          (deletion) =>
            deletion.privacyRequestId === privacyRequestId &&
            deletion.status !== "deleted",
        ).length;
        return [{ count: String(count) }];
      }
      return input.resolve(query);
    },
    {
      array: (values: readonly unknown[]) => [...values],
      json: (value: unknown) => value,
    },
  ) as unknown as RetentionTransactionSql;
  const database = {
    withTenant: async <T>(
      tenantId: string,
      callback: (tx: RetentionTransactionSql) => Promise<T>,
    ): Promise<T> => {
      tenantContexts.push(tenantId);
      return callback(transaction);
    },
  } as unknown as RetentionDatabase;
  const rawPayloadStore: RawPayloadStore = {
    putEncryptedPayload: async () => "source-events/example",
    deleteEncryptedPayload: async (reference) => {
      input.deletedRawPayloads?.push(reference);
    },
    ready: async () => true,
  };
  return {
    repository: new RetentionRepository(database, crypto, {
      maxJobAttempts: 8,
      jobLeaseSeconds: 120,
      externalWritesEnabled: false,
      sendEnabled: false,
      rawPayloadStore,
    }),
    crypto,
    queries,
    tenantContexts,
  };
}

describe("retention privacy workflows", () => {
  test.each([
    ["canonical", "name"],
    ["historical", "display-name"],
  ] as const)(
    "reads %s display-name ciphertext in access, export, and preview paths",
    async (_label, contextSuffix) => {
      let displayNameCiphertext = "";
      const setup = createRepository({
        resolve(query) {
          if (
            query.sql.includes("FROM retention_customers AS customer") &&
            query.sql.includes("identity_count")
          ) {
            return [
              {
                brand_id: brandId,
                status: "active",
                primary_email_ciphertext: null,
                primary_phone_ciphertext: null,
                display_name_ciphertext: displayNameCiphertext,
                updated_at: new Date("2026-07-28T12:00:00.000Z"),
                identity_count: "0",
                trait_count: "0",
                consent_count: "0",
                source_event_count: "0",
                decision_count: "0",
                message_count: "0",
                segment_membership_count: "0",
              },
            ];
          }
          if (
            query.sql.includes("FROM retention_customers") &&
            query.sql.includes("source_updated_at")
          ) {
            return [
              {
                brand_id: brandId,
                status: "active",
                primary_email_ciphertext: null,
                primary_phone_ciphertext: null,
                display_name_ciphertext: displayNameCiphertext,
                source_updated_at: null,
                created_at: new Date("2026-07-28T11:00:00.000Z"),
                updated_at: new Date("2026-07-28T12:00:00.000Z"),
              },
            ];
          }
          if (
            query.sql.includes("FROM retention_customers") &&
            query.sql.includes("primary_email_ciphertext") &&
            !query.sql.includes("source_updated_at")
          ) {
            return [
              {
                primary_email_ciphertext: null,
                primary_phone_ciphertext: null,
                display_name_ciphertext: displayNameCiphertext,
              },
            ];
          }
          return [];
        },
      });
      displayNameCiphertext = setup.crypto.encrypt(
        "Example User",
        `${organizationId}:customer:${customerId}:${contextSuffix}`,
      );

      const access = await setup.repository.customerPrivacyAccess(
        context,
        customerId,
      );
      expect(access.profile.displayName).toBe("Example User");

      const exported = await setup.repository.exportCustomerData(
        context,
        customerId,
      );
      expect((exported.customer as { displayName: string }).displayName).toBe(
        "Example User",
      );

      await expect(
        setup.repository.explainCustomer(context, { customerId }),
      ).resolves.toMatchObject({
        currentDecision: null,
        decisionHistory: [],
      });
      expect(setup.tenantContexts).toEqual([
        organizationId,
        organizationId,
        organizationId,
      ]);
    },
  );

  test("deletes customer payloads once and replays idempotently", async () => {
    const deletedRawPayloads: string[] = [];
    let customerStatus = "active";
    let requestCompleted = false;
    const setup = createRepository({
      deletedRawPayloads,
      resolve(query) {
        if (
          query.sql.startsWith("SELECT brand_id, status") &&
          query.sql.includes("FROM retention_customers")
        ) {
          return [{ brand_id: brandId, status: customerStatus }];
        }
        if (query.sql.includes("FROM retention_privacy_requests")) {
          return requestCompleted
            ? [
                {
                  id: "66666666-6666-4666-8666-666666666666",
                  status: "completed",
                  raw_payload_count: "1",
                },
              ]
            : [];
        }
        if (
          query.sql.includes("primary_email_blind_index") &&
          query.sql.includes("FOR UPDATE")
        ) {
          return [
            {
              brand_id: brandId,
              status: customerStatus,
              primary_email_blind_index: "email-index",
              primary_phone_blind_index: null,
            },
          ];
        }
        if (
          query.sql.includes("FROM retention_source_events") &&
          query.sql.includes("raw_payload_ref")
        ) {
          return [
            {
              id: sourceEventId,
              raw_payload_ref: `source-events/${organizationId}/${sourceEventId}`,
            },
          ];
        }
        if (
          query.sql.startsWith("UPDATE retention_privacy_requests") &&
          query.sql.includes("status = 'completed'")
        ) {
          requestCompleted = true;
        }
        if (
          query.sql.startsWith("UPDATE retention_customers") &&
          query.sql.includes("status = 'deleted'")
        ) {
          customerStatus = "deleted";
        }
        return [];
      },
    });

    const first = await setup.repository.deleteCustomer(context, {
      customerId,
      idempotencyKey: "privacy-request-0001",
      reason: "Verified customer request.",
    });
    const replay = await setup.repository.deleteCustomer(context, {
      customerId,
      idempotencyKey: "privacy-request-0001",
      reason: "Verified customer request.",
    });

    expect(first).toEqual({
      customerId,
      status: "deleted",
      rawPayloadsDeleted: 1,
      duplicate: false,
    });
    expect(replay).toEqual({
      customerId,
      status: "deleted",
      rawPayloadsDeleted: 1,
      duplicate: true,
    });
    expect(deletedRawPayloads).toEqual([
      `source-events/${organizationId}/${sourceEventId}`,
    ]);
    expect(
      setup.queries.some(
        (query) =>
          query.sql.includes("customer_external_id_ciphertext = NULL") &&
          query.sql.includes("raw_payload_ref ="),
      ),
    ).toBe(true);
  });

  test("revokes integration secrets without returning them", async () => {
    let status = "active";
    const reason = "The owner disconnected this source.";
    const setup = createRepository({
      resolve(query) {
        if (
          query.sql.startsWith("SELECT provider, status") &&
          query.sql.includes("FROM retention_integrations")
        ) {
          return [{ provider: "shopify", status }];
        }
        if (
          query.sql.startsWith("UPDATE retention_integrations") &&
          query.sql.includes("credential_ciphertext = NULL")
        ) {
          status = "revoked";
        }
        return [];
      },
    });

    const result = await setup.repository.revokeIntegration(context, {
      integrationId,
      reason,
    });
    const replay = await setup.repository.revokeIntegration(context, {
      integrationId,
      reason,
    });

    expect(result).toEqual({
      integrationId,
      provider: "shopify",
      status: "revoked",
      duplicate: false,
    });
    expect(replay.duplicate).toBe(true);
    const update = setup.queries.find(
      (query) =>
        query.sql.startsWith("UPDATE retention_integrations") &&
        query.sql.includes("credential_ciphertext = NULL"),
    );
    expect(update?.sql).toContain("webhook_secret_ciphertext = NULL");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(setup.queries)).not.toContain(reason);
  });

  test.each([
    ["app/uninstalled", "integration.revoked_from_uninstall"],
    ["shop/redact", "brand.privacy_erased"],
  ])(
    "handles identifier-less Shopify %s before customer resolution",
    async (eventType, expectedAuditAction) => {
      const deletedRawPayloads: string[] = [];
      let encryptedPayload = "";
      const setup = createRepository({
        deletedRawPayloads,
        resolve(query) {
          if (
            query.sql.includes("FROM retention_source_events AS event") &&
            query.sql.includes("FOR UPDATE OF event")
          ) {
            return [
              {
                id: sourceEventId,
                brand_id: brandId,
                integration_id: integrationId,
                provider: "shopify",
                external_event_id: "provider-event-123",
                event_type: eventType,
                payload_ciphertext: encryptedPayload,
                raw_payload_ref: `source-events/${organizationId}/${sourceEventId}`,
                processing_status: "pending",
                occurred_at: new Date("2026-07-28T12:00:00.000Z"),
                property_allowlist: [],
              },
            ];
          }
          if (
            query.sql.startsWith("SELECT id") &&
            query.sql.includes("FROM retention_customers") &&
            query.sql.includes("brand_id")
          ) {
            return [];
          }
          if (
            query.sql.includes("FROM retention_source_events") &&
            query.sql.includes("raw_payload_ref")
          ) {
            return [
              {
                id: sourceEventId,
                raw_payload_ref: `source-events/${organizationId}/${sourceEventId}`,
              },
            ];
          }
          return [];
        },
      });
      encryptedPayload = setup.crypto.encrypt(
        JSON.stringify({ source: { topic: eventType } }),
        `${organizationId}:source-event:${sourceEventId}:payload`,
      );

      const result = await setup.repository.processSourceEvent(
        organizationId,
        sourceEventId,
      );

      expect(result).toEqual({
        eventId: sourceEventId,
        customerId: null,
        status: "processed",
        reasonJobs: 0,
      });
      expect(deletedRawPayloads).toEqual([]);
      expect(
        setup.queries.some((query) =>
          query.sql.startsWith("INSERT INTO retention_raw_payload_deletions"),
        ),
      ).toBe(true);
      expect(
        setup.queries.some(
          (query) =>
            query.sql.includes("INSERT INTO retention_jobs") &&
            query.values.includes("delete_raw_payload"),
        ),
      ).toBe(true);
      expect(
        setup.queries.some(
          (query) =>
            query.sql.includes("INSERT INTO retention_audit_events") &&
            query.values.includes(expectedAuditAction),
        ),
      ).toBe(true);
    },
  );
});
