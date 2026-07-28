import { describe, expect, test } from "bun:test";

import { RetentionServiceWorker } from "./worker.js";

const organizationA = "11111111-1111-4111-8111-111111111111";
const organizationB = "22222222-2222-4222-8222-222222222222";
const eventId = "33333333-3333-4333-8333-333333333333";

describe("RetentionServiceWorker", () => {
  test("processes only explicitly awakened tenants and drains their jobs", async () => {
    const claims: string[] = [];
    const processed: string[] = [];
    const completed: string[] = [];
    const scheduled: string[] = [];
    let jobsRemaining = 2;
    const worker = new RetentionServiceWorker(
      {
        claimJob: async (organizationId) => {
          claims.push(organizationId);
          if (organizationId !== organizationA || jobsRemaining === 0) {
            return null;
          }
          jobsRemaining -= 1;
          return {
            id: `job-${jobsRemaining}`,
            type: "normalize_source_event",
            payload: { eventId },
            attempts: 1,
          };
        },
        scheduleTenantSyncs: async (organizationId) => {
          scheduled.push(organizationId);
        },
        processProviderSyncPage: async () => {
          throw new Error("No provider sync page should be processed.");
        },
        processRawPayloadDeletion: async () => {
          throw new Error("No raw payload should be deleted.");
        },
        processRawPayloadPersistence: async () => {
          throw new Error("No raw payload should be persisted.");
        },
        recordProviderSyncFailure: async () => undefined,
        processSourceEvent: async (organizationId, sourceEventId) => {
          processed.push(`${organizationId}:${sourceEventId}`);
          return {
            eventId: sourceEventId,
            customerId: null,
            status: "processed" as const,
            reasonJobs: 0,
          };
        },
        completeJob: async (organizationId, _workerId, jobId) => {
          completed.push(`${organizationId}:${jobId}`);
        },
        failJob: async () => {
          throw new Error("No job should fail.");
        },
      },
      1,
    );

    worker.start();
    worker.wakeTenant(organizationA);
    await Bun.sleep(20);
    await worker.stop();

    expect(claims).toEqual([
      organizationA,
      organizationA,
      organizationA,
    ]);
    expect(processed).toHaveLength(2);
    expect(completed).toHaveLength(2);
    expect(scheduled).toEqual([
      organizationA,
      organizationA,
      organizationA,
    ]);
    expect(claims).not.toContain(organizationB);
  });

  test("deduplicates repeated wakeups and rejects invalid tenant ids", async () => {
    let claimCount = 0;
    const worker = new RetentionServiceWorker(
      {
        claimJob: async () => {
          claimCount += 1;
          return null;
        },
        scheduleTenantSyncs: async () => undefined,
        processProviderSyncPage: async () => {
          throw new Error("No provider sync page should be processed.");
        },
        processRawPayloadDeletion: async () => {
          throw new Error("No raw payload should be deleted.");
        },
        processRawPayloadPersistence: async () => {
          throw new Error("No raw payload should be persisted.");
        },
        recordProviderSyncFailure: async () => undefined,
        processSourceEvent: async () => {
          throw new Error("No job should be processed.");
        },
        completeJob: async () => undefined,
        failJob: async () => undefined,
      },
      1,
    );

    expect(() => worker.wakeTenant("not-an-organization")).toThrow(
      "organization is invalid",
    );
    worker.wakeTenant(organizationA);
    worker.wakeTenant(organizationA);
    worker.start();
    await Bun.sleep(10);
    await worker.stop();

    expect(claimCount).toBe(1);
  });

  test("processes provider sync jobs and records failures before retry", async () => {
    const integrationId = "44444444-4444-4444-8444-444444444444";
    const failures: string[] = [];
    let claimed = false;
    const worker = new RetentionServiceWorker(
      {
        scheduleTenantSyncs: async () => undefined,
        claimJob: async () => {
          if (claimed) return null;
          claimed = true;
          return {
            id: "sync-job",
            type: "sync_provider_page",
            payload: {
              integrationId,
              lifecycle: "incremental_poll",
              resource: "customers",
            },
            attempts: 1,
          };
        },
        processProviderSyncPage: async () => {
          throw new Error("Provider is unavailable.");
        },
        processRawPayloadDeletion: async () => {
          throw new Error("No raw payload should be deleted.");
        },
        processRawPayloadPersistence: async () => {
          throw new Error("No raw payload should be persisted.");
        },
        recordProviderSyncFailure: async (_organizationId, payload, error) => {
          failures.push(`${payload.integrationId}:${error.code}`);
        },
        processSourceEvent: async () => {
          throw new Error("No source event should be processed.");
        },
        completeJob: async () => {
          throw new Error("Failed sync jobs must not complete.");
        },
        failJob: async () => undefined,
      },
      1,
    );

    worker.start();
    worker.wakeTenant(organizationA);
    await Bun.sleep(10);
    await worker.stop();

    expect(failures).toEqual([
      `${integrationId}:retention_sync_failed`,
    ]);
  });

  test("drains durable raw-payload deletion jobs", async () => {
    const deletionId = "55555555-5555-4555-8555-555555555555";
    const processed: string[] = [];
    let claimed = false;
    const worker = new RetentionServiceWorker(
      {
        scheduleTenantSyncs: async () => undefined,
        claimJob: async () => {
          if (claimed) return null;
          claimed = true;
          return {
            id: "delete-job",
            type: "delete_raw_payload",
            payload: { deletionId },
            attempts: 1,
          };
        },
        processProviderSyncPage: async () => {
          throw new Error("No provider sync page should be processed.");
        },
        processRawPayloadDeletion: async (
          receivedOrganizationId,
          receivedDeletionId,
        ) => {
          processed.push(
            `${receivedOrganizationId}:${receivedDeletionId}`,
          );
          return { deletionId: receivedDeletionId, duplicate: false };
        },
        processRawPayloadPersistence: async () => {
          throw new Error("No raw payload should be persisted.");
        },
        recordProviderSyncFailure: async () => undefined,
        processSourceEvent: async () => {
          throw new Error("No source event should be processed.");
        },
        completeJob: async () => undefined,
        failJob: async () => {
          throw new Error("Deletion job should not fail.");
        },
      },
      1,
    );

    worker.start();
    worker.wakeTenant(organizationA);
    await Bun.sleep(10);
    await worker.stop();

    expect(processed).toEqual([
      `${organizationA}:${deletionId}`,
    ]);
  });
});
