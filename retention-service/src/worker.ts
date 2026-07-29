import { randomUUID } from "node:crypto";

import type {
  ProviderSyncJobPayload,
  RetentionRepository,
} from "./repository.js";
import { RetentionServiceError } from "./types.js";

const SERVICE_JOB_TYPES = [
  "persist_raw_payload",
  "normalize_source_event",
  "sync_provider_page",
  "delete_raw_payload",
] as const;

export class RetentionServiceWorker {
  readonly #workerId = `retention-service:${randomUUID()}`;
  readonly #pendingTenants = new Set<string>();
  #stopped = false;
  #running: Promise<void> | null = null;
  #wakeResolver: (() => void) | null = null;

  constructor(
    readonly repository: Pick<
      RetentionRepository,
      | "claimJob"
      | "completeJob"
      | "failJob"
      | "processProviderSyncPage"
      | "processRawPayloadDeletion"
      | "processRawPayloadPersistence"
      | "processSourceEvent"
      | "recordProviderSyncFailure"
      | "scheduleTenantSyncs"
    >,
    readonly idleDelayMs = 500,
  ) {}

  start(): void {
    if (this.#running) return;
    this.#running = this.run();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#wakeResolver?.();
    await this.#running;
  }

  wakeTenant(organizationId: string): void {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        organizationId,
      )
    ) {
      throw new RetentionServiceError(
        "invalid_organization",
        "The retention organization is invalid.",
        400,
      );
    }
    this.#pendingTenants.add(organizationId);
    this.#wakeResolver?.();
  }

  private async run(): Promise<void> {
    while (!this.#stopped) {
      const organizationId = this.#pendingTenants.values().next().value as
        | string
        | undefined;
      if (!organizationId) {
        await this.waitForWake();
        continue;
      }
      this.#pendingTenants.delete(organizationId);
      try {
        await this.repository.scheduleTenantSyncs(organizationId);
        const job = await this.repository.claimJob(
          organizationId,
          this.#workerId,
          SERVICE_JOB_TYPES,
        );
        if (!job) continue;
        try {
          if (
            job.type === "persist_raw_payload" ||
            job.type === "normalize_source_event"
          ) {
            const eventId =
              job.payload &&
              typeof job.payload === "object" &&
              typeof (job.payload as { eventId?: unknown }).eventId ===
                "string"
                ? (job.payload as { eventId: string }).eventId
                : null;
            if (!eventId) {
              throw new RetentionServiceError(
                "invalid_job_payload",
                "The source-event job payload is invalid.",
                422,
              );
            }
            if (job.type === "persist_raw_payload") {
              await this.repository.processRawPayloadPersistence(
                organizationId,
                eventId,
              );
            } else {
              await this.repository.processSourceEvent(
                organizationId,
                eventId,
              );
            }
          } else if (job.type === "sync_provider_page") {
            const payload = providerSyncPayload(job.payload);
            await this.repository.processProviderSyncPage(
              organizationId,
              payload,
            );
          } else if (job.type === "delete_raw_payload") {
            const deletionId =
              job.payload &&
              typeof job.payload === "object" &&
              typeof (job.payload as { deletionId?: unknown })
                .deletionId === "string"
                ? (job.payload as { deletionId: string }).deletionId
                : null;
            if (!deletionId) {
              throw new RetentionServiceError(
                "invalid_job_payload",
                "The raw-payload deletion job payload is invalid.",
                422,
              );
            }
            await this.repository.processRawPayloadDeletion(
              organizationId,
              deletionId,
            );
          }
          await this.repository.completeJob(
            organizationId,
            this.#workerId,
            job.id,
          );
        } catch (error) {
          if (job.type === "sync_provider_page") {
            try {
              await this.repository.recordProviderSyncFailure(
                organizationId,
                providerSyncPayload(job.payload),
                {
                  code:
                    error instanceof RetentionServiceError
                      ? error.code
                      : "retention_sync_failed",
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              );
            } catch (recordError) {
              console.error("retention_sync_failure_record_failed", {
                organizationId,
                error:
                  recordError instanceof Error
                    ? recordError.message
                    : String(recordError),
              });
            }
          }
          await this.repository.failJob(
            organizationId,
            this.#workerId,
            job.id,
            {
              code:
                error instanceof RetentionServiceError
                  ? error.code
                  : "retention_job_failed",
              message:
                error instanceof Error ? error.message : String(error),
            },
          );
        }
        this.wakeTenant(organizationId);
      } catch (error) {
        console.error("retention_worker_iteration_failed", {
          organizationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async waitForWake(): Promise<void> {
    await Promise.race([
      new Promise<void>((resolve) => {
        this.#wakeResolver = resolve;
      }),
      Bun.sleep(this.idleDelayMs),
    ]);
    this.#wakeResolver = null;
  }
}

function providerSyncPayload(value: unknown): ProviderSyncJobPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RetentionServiceError(
      "invalid_job_payload",
      "The provider synchronization job payload is invalid.",
      422,
    );
  }
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.integrationId !== "string" ||
    (payload.migrationRunId !== undefined &&
      typeof payload.migrationRunId !== "string") ||
    ![
      "historical_backfill",
      "incremental_poll",
      "reconciliation",
    ].includes(String(payload.lifecycle)) ||
    !["customers", "orders", "profiles", "events"].includes(
      String(payload.resource),
    )
  ) {
    throw new RetentionServiceError(
      "invalid_job_payload",
      "The provider synchronization job payload is invalid.",
      422,
    );
  }
  return payload as unknown as ProviderSyncJobPayload;
}
