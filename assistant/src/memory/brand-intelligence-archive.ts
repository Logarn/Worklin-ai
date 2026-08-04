import { ipcCall } from "../ipc/gateway-client.js";
import type { ToolContext } from "../tools/types.js";

export type BrandIntelligenceArchiveResult =
  | {
      status: "queued" | "complete" | "partial";
      jobId: string;
      snapshotId: string;
      idempotent: boolean;
      warning: boolean;
    }
  | {
      status: "skipped" | "unavailable";
      reason: string;
    };

export async function archiveBrandIntelligence(input: {
  context: ToolContext;
  brandId: string;
  snapshotId: string;
  brandBrain: Record<string, unknown>;
  report: Record<string, unknown>;
  quality: Record<string, unknown> | null;
}): Promise<BrandIntelligenceArchiveResult> {
  const { context } = input;
  if (
    !context.platformOrganizationId ||
    !context.platformUserId ||
    !context.platformAssistantId
  ) {
    return { status: "skipped", reason: "platform_context_missing" };
  }

  try {
    const result = await ipcCall(
      "brand_intelligence_archive_request",
      {
        organizationId: context.platformOrganizationId,
        userId: context.platformUserId,
        assistantId: context.platformAssistantId,
        brandId: input.brandId,
        snapshotId: input.snapshotId,
        brandBrain: input.brandBrain,
        report: input.report,
        quality: input.quality,
      },
      10_000,
    );
    if (!isArchiveResponse(result)) {
      return { status: "unavailable", reason: "archive_response_invalid" };
    }
    if (result.status < 200 || result.status >= 300) {
      return {
        status: "unavailable",
        reason: archiveErrorCode(result.body),
      };
    }
    const body = result.body as Record<string, unknown>;
    const archive = body.archive as Record<string, unknown>;
    const usage = body.usage as Record<string, unknown>;
    return {
      status: archive.status as "queued" | "complete" | "partial",
      jobId: archive.jobId as string,
      snapshotId: archive.snapshotId as string,
      idempotent: archive.idempotent as boolean,
      warning: usage.warning as boolean,
    };
  } catch {
    return { status: "unavailable", reason: "archive_request_failed" };
  }
}

function isArchiveResponse(
  value: unknown,
): value is { status: number; body: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  if (typeof response.status !== "number" || !isRecord(response.body)) {
    return false;
  }
  if (response.status < 200 || response.status >= 300) return true;
  const archive = response.body.archive;
  const usage = response.body.usage;
  return (
    isRecord(archive) &&
    (archive.status === "queued" ||
      archive.status === "complete" ||
      archive.status === "partial") &&
    typeof archive.jobId === "string" &&
    typeof archive.snapshotId === "string" &&
    typeof archive.idempotent === "boolean" &&
    isRecord(usage) &&
    typeof usage.warning === "boolean"
  );
}

function archiveErrorCode(body: unknown): string {
  if (!isRecord(body) || !isRecord(body.error)) {
    return "archive_request_rejected";
  }
  return typeof body.error.code === "string"
    ? body.error.code
    : "archive_request_rejected";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
