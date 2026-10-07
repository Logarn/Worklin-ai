import { z } from "zod";

import { SYNC_TAGS } from "../../daemon/message-types/sync.js";
import {
  FARM_RECORD_ACTIVITY_STATES,
  FARM_RECORD_ATTENTION_LEVELS,
  FARM_RECORD_CATEGORIES,
  listFarmBrands,
  listFarmRecords,
  upsertFarmRecord,
} from "../../memory/farm-record-store.js";
import { publishSyncInvalidation } from "../../runtime/sync/sync-publisher.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

const selectorSchema = z.object({
  farm_id: z.string().trim().min(1).max(128).optional(),
  farm_name: z.string().trim().min(1).max(200).optional(),
});

const upsertSchema = selectorSchema
  .extend({
    record_id: z.string().trim().min(1).max(128).optional(),
    title: z.string().trim().min(1).max(200),
    reference: z.string().trim().min(1).max(128).optional(),
    category: z.enum(FARM_RECORD_CATEGORIES),
    record_type: z.string().trim().min(1).max(120),
    status: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(2_000),
    attention_level: z.enum(FARM_RECORD_ATTENTION_LEVELS),
    occurred_at: z.string().trim().min(1).max(120).optional(),
    amount: z.string().trim().min(1).max(120).optional(),
    details: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(120),
          value: z.string().trim().min(1).max(500),
        }),
      )
      .max(30)
      .optional(),
    activity_note: z.string().trim().min(1).max(500),
    activity_state: z.enum(FARM_RECORD_ACTIVITY_STATES),
  })
  .refine((value) => value.farm_id || value.farm_name, {
    message: "farm_id or farm_name is required",
  });

function jsonResult(value: unknown, isError = false): ToolExecutionResult {
  return { content: JSON.stringify(value, null, 2), isError };
}

function farmIdFromName(farmName: string): string {
  const slug = farmName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 100);
  if (!slug) throw new Error("Farm name cannot be converted to a stable id.");
  return `farm-${slug}`;
}

export async function executeFarmRecordsList(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const selector = selectorSchema.parse(input);
    const result = listFarmRecords({
      farmId: selector.farm_id,
      farmName: selector.farm_name,
    });
    return jsonResult({
      farm: result.farm,
      records: result.records,
      statusLanguage:
        "Requested is not confirmed. Ordered is not delivered. Invoiced is not paid. Assigned is not completed.",
    });
  } catch (error) {
    return jsonResult(
      {
        error: error instanceof Error ? error.message : String(error),
        availableFarms: listFarmBrands(),
      },
      true,
    );
  }
}

export async function executeFarmRecordUpsert(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const parsed = upsertSchema.parse(input);
    const existingFarm = parsed.farm_id
      ? listFarmBrands().find((farm) => farm.id === parsed.farm_id)
      : listFarmBrands().find(
          (farm) => farm.name.toLowerCase() === parsed.farm_name?.toLowerCase(),
        );
    const farmName = parsed.farm_name ?? existingFarm?.name;
    if (!farmName) {
      return jsonResult(
        { error: "farm_name is required when creating a farm record." },
        true,
      );
    }
    const record = upsertFarmRecord({
      farmId: parsed.farm_id ?? existingFarm?.id ?? farmIdFromName(farmName),
      farmName,
      recordId: parsed.record_id,
      title: parsed.title,
      reference: parsed.reference,
      category: parsed.category,
      recordType: parsed.record_type,
      status: parsed.status,
      summary: parsed.summary,
      attentionLevel: parsed.attention_level,
      occurredAt: parsed.occurred_at,
      amount: parsed.amount,
      details: parsed.details,
      activity: {
        label: parsed.activity_note,
        state: parsed.activity_state,
        conversationId: context.conversationId,
      },
    });
    await publishSyncInvalidation([SYNC_TAGS.artifactsList]);
    return jsonResult({
      saved: true,
      record,
      visibleIn: "Work",
    });
  } catch (error) {
    return jsonResult(
      { error: error instanceof Error ? error.message : String(error) },
      true,
    );
  }
}
