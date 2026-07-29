import { describe, expect, test } from "bun:test";

import { RetentionCrypto } from "./crypto.js";
import type {
  RetentionDatabase,
  RetentionTransactionSql,
} from "./database.js";
import {
  rawPayloadReference,
  type RawPayloadStore,
} from "./raw-payload-store.js";
import { RetentionRepository } from "./repository.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const brandId = "22222222-2222-4222-8222-222222222222";
const integrationId = "33333333-3333-4333-8333-333333333333";

describe("source-event raw payload rollback", () => {
  test("never writes an unreferenced raw object when the database transaction fails", async () => {
    const deleted: string[] = [];
    const attemptedReferences: string[] = [];
    let uploadCount = 0;
    const transaction = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?").replace(/\s+/gu, " ").trim();
        if (
          sql.startsWith("SELECT brand_id, provider") &&
          sql.includes("FROM retention_integrations")
        ) {
          return [{ brand_id: brandId, provider: "shopify" }];
        }
        if (sql.startsWith("INSERT INTO retention_source_event_dedup")) {
          return [{ event_id: values[4] }];
        }
        if (sql.startsWith("INSERT INTO retention_source_payload_dedup")) {
          return [{ event_id: values[3] }];
        }
        if (sql.startsWith("INSERT INTO retention_source_events")) {
          attemptedReferences.push(String(values[8]));
          throw new Error("database commit failed");
        }
        return [];
      },
      {
        array: (values: readonly unknown[]) => [...values],
        json: (value: unknown) => value,
      },
    ) as unknown as RetentionTransactionSql;
    const database = {
      withTenant: async <T>(
        _tenantId: string,
        callback: (tx: RetentionTransactionSql) => Promise<T>,
      ): Promise<T> => callback(transaction),
    } as unknown as RetentionDatabase;
    const rawPayloadStore: RawPayloadStore = {
      putEncryptedPayload: async () => {
        uploadCount += 1;
        return "source-events/unexpected";
      },
      deleteEncryptedPayload: async (reference) => {
        deleted.push(reference);
      },
      ready: async () => true,
    };
    const repository = new RetentionRepository(
      database,
      new RetentionCrypto(Buffer.alloc(32, 17)),
      {
        maxJobAttempts: 8,
        jobLeaseSeconds: 120,
        externalWritesEnabled: false,
        sendEnabled: false,
        rawPayloadStore,
      },
    );
    const input = {
      integrationId,
      provider: "shopify" as const,
      externalEventId: "customer:42",
      eventType: "customers/update",
      occurredAt: "2026-07-28T12:00:00.000Z",
      signatureVerified: true,
      payload: { customer: { externalId: "42" } },
    };

    await expect(
      repository.appendSourceEvent(organizationId, input),
    ).rejects.toThrow("database commit failed");
    await expect(
      repository.appendSourceEvent(organizationId, input),
    ).rejects.toThrow("database commit failed");
    expect(uploadCount).toBe(0);
    expect(deleted).toEqual([]);
    expect(attemptedReferences).toHaveLength(2);
    expect(attemptedReferences[1]).toBe(attemptedReferences[0]);
  });

  test("locks the source event before writing so privacy cannot win the race", async () => {
    const eventId = "44444444-4444-4444-8444-444444444444";
    const occurredAt = new Date("2026-07-28T12:00:00.000Z");
    const expectedReference = rawPayloadReference({
      organizationId,
      integrationId,
      eventId,
      occurredAt,
    });
    const jobTypes: string[] = [];
    let sourceEventLocked = false;
    let uploadedAfterLock = false;
    const transaction = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?").replace(/\s+/gu, " ").trim();
        if (
          sql.startsWith("SELECT integration_id, raw_payload_ref") &&
          sql.includes("FROM retention_source_events")
        ) {
          expect(sql).toContain("FOR UPDATE");
          sourceEventLocked = true;
          return [
            {
              integration_id: integrationId,
              raw_payload_ref: expectedReference,
              payload_ciphertext: "encrypted-payload",
              occurred_at: occurredAt,
            },
          ];
        }
        if (sql.startsWith("INSERT INTO retention_jobs")) {
          jobTypes.push(String(values[2]));
          return [];
        }
        return [];
      },
      {
        array: (values: readonly unknown[]) => [...values],
        json: (value: unknown) => value,
      },
    ) as unknown as RetentionTransactionSql;
    const database = {
      withTenant: async <T>(
        _tenantId: string,
        callback: (tx: RetentionTransactionSql) => Promise<T>,
      ): Promise<T> => callback(transaction),
    } as unknown as RetentionDatabase;
    const rawPayloadStore: RawPayloadStore = {
      putEncryptedPayload: async () => {
        expect(sourceEventLocked).toBe(true);
        uploadedAfterLock = true;
        return expectedReference;
      },
      deleteEncryptedPayload: async () => undefined,
      ready: async () => true,
    };
    const repository = new RetentionRepository(
      database,
      new RetentionCrypto(Buffer.alloc(32, 17)),
      {
        maxJobAttempts: 8,
        jobLeaseSeconds: 120,
        externalWritesEnabled: false,
        sendEnabled: false,
        rawPayloadStore,
      },
    );

    await expect(
      repository.processRawPayloadPersistence(organizationId, eventId),
    ).resolves.toEqual({ eventId, duplicate: false });
    expect(uploadedAfterLock).toBe(true);
    expect(jobTypes).toEqual(["normalize_source_event"]);
  });
});
