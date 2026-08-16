import { describe, expect, test } from "bun:test";

import { RetentionCrypto } from "./crypto.js";
import type {
  RetentionDatabase,
  RetentionTransactionSql,
} from "./database.js";
import type { RawPayloadStore } from "./raw-payload-store.js";
import { RetentionRepository } from "./repository.js";
import { RetentionServiceError, type TenantContext } from "./types.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const campaignId = "22222222-2222-4222-8222-222222222222";
const integrationId = "33333333-3333-4333-8333-333333333333";
const brandId = "44444444-4444-4444-8444-444444444444";

const context: TenantContext = {
  organizationId,
  userId: "user-123",
  assistantId: "assistant-123",
  roles: ["retention_marketer"],
  permissions: ["retention:read", "retention:write", "retention:send"],
  requestId: "request-123",
};

const rawPayloadStore: RawPayloadStore = {
  putEncryptedPayload: async () => "source-events/example",
  deleteEncryptedPayload: async () => undefined,
  ready: async () => true,
};

interface RecordedQuery {
  sql: string;
  values: unknown[];
}

function repositoryWithQueries(
  resolve: (query: RecordedQuery) => unknown[],
): {
  repository: RetentionRepository;
  queries: RecordedQuery[];
  tenantContexts: string[];
} {
  const queries: RecordedQuery[] = [];
  const tenantContexts: string[] = [];
  const transaction = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = {
        sql: strings.join("?").replace(/\s+/gu, " ").trim(),
        values,
      };
      queries.push(query);
      return resolve(query);
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
  return {
    repository: new RetentionRepository(
      database,
      new RetentionCrypto(Buffer.alloc(32, 9)),
      {
        maxJobAttempts: 8,
        jobLeaseSeconds: 120,
        externalWritesEnabled: false,
        sendEnabled: false,
        rawPayloadStore,
      },
    ),
    queries,
    tenantContexts,
  };
}

describe("retention operator repository", () => {
  test("returns import summaries without manifests, checkpoints, or credentials", async () => {
    const updatedAt = new Date("2026-07-28T12:00:00.000Z");
    const setup = repositoryWithQueries((query) => {
      if (query.sql.includes("FROM retention_migration_runs AS migration")) {
        return [
          {
            id: "55555555-5555-4555-8555-555555555555",
            brand_id: brandId,
            integration_id: integrationId,
            provider: "shopify",
            status: "running",
            imported_count: "100",
            rejected_count: "2",
            approved_at: null,
            started_at: updatedAt,
            completed_at: null,
            last_error_code: null,
            updated_at: updatedAt,
            has_checkpoint: true,
          },
        ];
      }
      return [];
    });

    const result = await setup.repository.reviewImports(context, {
      brandId,
      limit: 20,
    });

    expect(setup.tenantContexts).toEqual([organizationId]);
    expect(result.imports[0]).toEqual({
      id: "55555555-5555-4555-8555-555555555555",
      brandId,
      integrationId,
      provider: "shopify",
      status: "running",
      importedCount: 100,
      rejectedCount: 2,
      approvedAt: null,
      startedAt: updatedAt.toISOString(),
      completedAt: null,
      lastErrorCode: null,
      updatedAt: updatedAt.toISOString(),
      hasCheckpoint: true,
    });
    expect(JSON.stringify(result)).not.toContain("manifest");
    expect(JSON.stringify(result)).not.toContain("credential");
    expect(
      setup.queries.some((query) =>
        query.sql.includes("INSERT INTO retention_audit_events"),
      ),
    ).toBe(true);
  });

  test("cancels only local queued work and audits a reason checksum", async () => {
    const reason = "The campaign objective changed.";
    const setup = repositoryWithQueries((query) => {
      if (
        query.sql.startsWith("SELECT status FROM retention_campaigns")
      ) {
        return [{ status: "approved" }];
      }
      if (
        query.sql.includes("FROM retention_dispatches") &&
        query.sql.includes("FOR UPDATE")
      ) {
        return [];
      }
      if (
        query.sql.includes("FROM retention_dispatch_recipients") &&
        query.sql.includes("count(*)")
      ) {
        return [{ accepted_count: "0" }];
      }
      if (
        query.sql.startsWith("UPDATE retention_dispatch_recipients")
      ) {
        return [];
      }
      if (query.sql.startsWith("UPDATE retention_dispatches")) {
        return [];
      }
      return [];
    });

    const result = await setup.repository.cancelCampaign(context, {
      campaignId,
      brandId,
      reason,
    });

    expect(result).toEqual({
      campaignId,
      status: "cancelled",
      cancelledDispatchCount: 0,
      cancelledRecipientCount: 0,
      duplicate: false,
    });
    expect(setup.tenantContexts).toEqual([organizationId]);
    expect(
      setup.queries.some((query) =>
        query.sql.includes("UPDATE retention_campaigns"),
      ),
    ).toBe(true);
    const audit = setup.queries.find((query) =>
      query.sql.includes("INSERT INTO retention_audit_events"),
    );
    expect(audit).toBeDefined();
    expect(audit?.values).not.toContain(reason);
    expect(JSON.stringify(audit?.values)).toContain("reasonSha256");
    expect(JSON.stringify(audit?.values)).not.toContain(reason);
  });

  test("refuses cancellation after a provider-side marker", async () => {
    const setup = repositoryWithQueries((query) => {
      if (
        query.sql.startsWith("SELECT status FROM retention_campaigns")
      ) {
        return [{ status: "ready_to_send" }];
      }
      if (
        query.sql.includes("FROM retention_dispatches") &&
        query.sql.includes("FOR UPDATE")
      ) {
        return [
          {
            id: "66666666-6666-4666-8666-666666666666",
            status: "pending",
            accepted_count: "0",
            provider_campaign_id: "provider-campaign",
            provider_list_id: null,
            provider_payload_reference: null,
          },
        ];
      }
      if (query.sql.includes("FROM retention_dispatch_recipients")) {
        return [{ accepted_count: "0" }];
      }
      if (query.sql.includes("FROM retention_jobs")) {
        return [{ running_count: "0" }];
      }
      return [];
    });

    try {
      await setup.repository.cancelCampaign(context, {
        campaignId,
        brandId,
        reason: "Cancel before sending.",
      });
      throw new Error("Expected cancellation to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(RetentionServiceError);
      expect((error as RetentionServiceError).code).toBe(
        "campaign_cancellation_unsafe",
      );
    }
    expect(
      setup.queries.some((query) => query.sql.startsWith("UPDATE ")),
    ).toBe(false);
  });
});
