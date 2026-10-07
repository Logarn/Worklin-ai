import { randomUUID } from "node:crypto";

import {
  createArtifactBrand,
  getArtifact,
  listArtifacts,
  listBrandArtifactSummaries,
} from "./artifact-store.js";
import { rawRun } from "./raw-query.js";

export const FARM_RECORD_CONTRACT_VERSION = "farm_record_v1";

export const FARM_RECORD_CATEGORIES = [
  "Production",
  "Purchases",
  "Sales",
  "Finance",
  "Inventory",
  "Workers",
  "Health",
  "Logistics",
  "Compliance",
  "Planning",
] as const;

export const FARM_RECORD_ATTENTION_LEVELS = [
  "normal",
  "watch",
  "action",
  "urgent",
] as const;

export const FARM_RECORD_ACTIVITY_STATES = [
  "done",
  "current",
  "pending",
] as const;

export type FarmRecordCategory = (typeof FARM_RECORD_CATEGORIES)[number];
export type FarmRecordAttentionLevel =
  (typeof FARM_RECORD_ATTENTION_LEVELS)[number];
export type FarmRecordActivityState =
  (typeof FARM_RECORD_ACTIVITY_STATES)[number];

export interface FarmRecordDetail {
  label: string;
  value: string;
}

export interface FarmRecordActivity {
  at: string;
  label: string;
  state: FarmRecordActivityState;
  conversationId?: string;
}

export interface FarmRecord {
  artifactId: string;
  brandId: string;
  recordId: string;
  title: string;
  reference: string;
  category: FarmRecordCategory;
  recordType: string;
  status: string;
  summary: string;
  attentionLevel: FarmRecordAttentionLevel;
  occurredAt?: string;
  amount?: string;
  details: FarmRecordDetail[];
  activity: FarmRecordActivity[];
  createdAt: number;
  updatedAt: number;
}

export interface FarmBrand {
  id: string;
  name: string;
}

export class FarmRecordStoreError extends Error {
  constructor(
    public readonly code: "not_found" | "ambiguous" | "invalid_record",
    message: string,
  ) {
    super(message);
    this.name = "FarmRecordStoreError";
  }
}

interface StoredFarmRecordMetadata {
  contractVersion: typeof FARM_RECORD_CONTRACT_VERSION;
  title: string;
  recordId: string;
  reference: string;
  category: FarmRecordCategory;
  recordType: string;
  status: string;
  summary: string;
  attentionLevel: FarmRecordAttentionLevel;
  occurredAt?: string;
  amount?: string;
  details: FarmRecordDetail[];
  activity: FarmRecordActivity[];
}

function cleanText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > maxLength) {
    throw new FarmRecordStoreError(
      "invalid_record",
      `${label} must be between 1 and ${maxLength} characters.`,
    );
  }
  return normalized;
}

function cleanRecordId(value: string): string {
  const recordId = value.trim();
  if (
    recordId.length < 1 ||
    recordId.length > 128 ||
    !/^[a-z0-9][a-z0-9._:-]*$/i.test(recordId)
  ) {
    throw new FarmRecordStoreError("invalid_record", "Invalid record id.");
  }
  return recordId;
}

function categoryKey(category: FarmRecordCategory): string {
  return category.toLowerCase().replace(/[^a-z0-9]+/gu, "_");
}

function isCategory(value: unknown): value is FarmRecordCategory {
  return FARM_RECORD_CATEGORIES.includes(value as FarmRecordCategory);
}

function isAttentionLevel(value: unknown): value is FarmRecordAttentionLevel {
  return FARM_RECORD_ATTENTION_LEVELS.includes(
    value as FarmRecordAttentionLevel,
  );
}

function isActivityState(value: unknown): value is FarmRecordActivityState {
  return FARM_RECORD_ACTIVITY_STATES.includes(value as FarmRecordActivityState);
}

function parseDetails(value: unknown): FarmRecordDetail[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const label = (item as { label?: unknown }).label;
    const detailValue = (item as { value?: unknown }).value;
    return typeof label === "string" && typeof detailValue === "string"
      ? [{ label, value: detailValue }]
      : [];
  });
}

function parseActivity(value: unknown): FarmRecordActivity[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.at !== "string" ||
      typeof candidate.label !== "string" ||
      !isActivityState(candidate.state)
    ) {
      return [];
    }
    return [
      {
        at: candidate.at,
        label: candidate.label,
        state: candidate.state,
        ...(typeof candidate.conversationId === "string"
          ? { conversationId: candidate.conversationId }
          : {}),
      },
    ];
  });
}

function parseMetadata(value: Record<string, unknown> | null) {
  if (
    value?.contractVersion !== FARM_RECORD_CONTRACT_VERSION ||
    typeof value.title !== "string" ||
    typeof value.recordId !== "string" ||
    typeof value.reference !== "string" ||
    !isCategory(value.category) ||
    typeof value.recordType !== "string" ||
    typeof value.status !== "string" ||
    typeof value.summary !== "string" ||
    !isAttentionLevel(value.attentionLevel)
  ) {
    return null;
  }
  return {
    contractVersion: FARM_RECORD_CONTRACT_VERSION,
    title: value.title,
    recordId: value.recordId,
    reference: value.reference,
    category: value.category,
    recordType: value.recordType,
    status: value.status,
    summary: value.summary,
    attentionLevel: value.attentionLevel,
    ...(typeof value.occurredAt === "string"
      ? { occurredAt: value.occurredAt }
      : {}),
    ...(typeof value.amount === "string" ? { amount: value.amount } : {}),
    details: parseDetails(value.details),
    activity: parseActivity(value.activity),
  } satisfies StoredFarmRecordMetadata;
}

function toFarmRecord(
  artifact: ReturnType<typeof getArtifact>,
): FarmRecord | null {
  if (artifact.resourceType !== "farm_record" || !artifact.brandId) return null;
  const metadata = parseMetadata(artifact.metadata);
  if (!metadata) return null;
  return {
    artifactId: artifact.id,
    brandId: artifact.brandId,
    ...metadata,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

function farmBrandIds(): Set<string> {
  return new Set(
    listArtifacts({ status: "active" })
      .filter(
        (artifact) =>
          artifact.resourceType === "farm_record" && artifact.brandId,
      )
      .map((artifact) => artifact.brandId!),
  );
}

export function listFarmBrands(): FarmBrand[] {
  const farmIds = farmBrandIds();
  return listBrandArtifactSummaries()
    .brands.filter((brand) => farmIds.has(brand.id))
    .map((brand) => ({ id: brand.id, name: brand.name }));
}

export function resolveFarmBrand(selector: {
  farmId?: string;
  farmName?: string;
}): FarmBrand {
  const brands = listFarmBrands();
  const farmId = selector.farmId?.trim();
  const farmName = selector.farmName?.trim().toLowerCase();
  const matches = brands.filter(
    (brand) =>
      (!farmId || brand.id === farmId) &&
      (!farmName || brand.name.toLowerCase() === farmName),
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new FarmRecordStoreError(
      "ambiguous",
      "More than one farm matched the selector.",
    );
  }
  if (!farmId && !farmName && brands.length === 1) return brands[0]!;
  throw new FarmRecordStoreError("not_found", "Farm records were not found.");
}

export function listFarmRecords(selector: {
  farmId?: string;
  farmName?: string;
}): { farm: FarmBrand; records: FarmRecord[] } {
  const farm = resolveFarmBrand(selector);
  const records = listArtifacts({ brandId: farm.id, status: "active" })
    .map(toFarmRecord)
    .filter((record): record is FarmRecord => record !== null);
  return { farm, records };
}

export function upsertFarmRecord(input: {
  farmId: string;
  farmName: string;
  recordId?: string;
  title: string;
  reference?: string;
  category: FarmRecordCategory;
  recordType: string;
  status: string;
  summary: string;
  attentionLevel: FarmRecordAttentionLevel;
  occurredAt?: string;
  amount?: string;
  details?: FarmRecordDetail[];
  activity: {
    label: string;
    state: FarmRecordActivityState;
    conversationId?: string;
  };
}): FarmRecord {
  const farmId = cleanRecordId(input.farmId);
  const farmName = cleanText(input.farmName, "Farm name", 200);
  const existingBrand = listBrandArtifactSummaries().brands.find(
    (brand) => brand.id === farmId,
  );
  if (existingBrand && existingBrand.name !== farmName) {
    throw new FarmRecordStoreError(
      "invalid_record",
      `Farm id ${farmId} already belongs to ${existingBrand.name}.`,
    );
  }
  if (!existingBrand) {
    createArtifactBrand({
      id: farmId,
      name: farmName,
      source: "farm-operator",
      metadata: { businessType: "poultry_farm" },
    });
  }

  const recordId = cleanRecordId(input.recordId ?? randomUUID());
  const resourceId = `${farmId}:${recordId}`;
  const artifactId = `farm_record:${resourceId}`;
  const now = Date.now();
  const current = (() => {
    try {
      return getArtifact(artifactId);
    } catch {
      return null;
    }
  })();
  const currentMetadata = current ? parseMetadata(current.metadata) : null;
  const activity: FarmRecordActivity[] = [
    ...(currentMetadata?.activity ?? []),
    {
      at: new Date(now).toISOString(),
      label: cleanText(input.activity.label, "Activity label", 500),
      state: input.activity.state,
      ...(input.activity.conversationId
        ? { conversationId: input.activity.conversationId }
        : {}),
    },
  ].slice(-100);
  const metadata: StoredFarmRecordMetadata = {
    contractVersion: FARM_RECORD_CONTRACT_VERSION,
    title: cleanText(input.title, "Title", 200),
    recordId,
    reference: cleanText(input.reference ?? recordId, "Reference", 128),
    category: input.category,
    recordType: cleanText(input.recordType, "Record type", 120),
    status: cleanText(input.status, "Status", 120),
    summary: cleanText(input.summary, "Summary", 2_000),
    attentionLevel: input.attentionLevel,
    ...(input.occurredAt
      ? { occurredAt: cleanText(input.occurredAt, "Record date", 120) }
      : {}),
    ...(input.amount ? { amount: cleanText(input.amount, "Amount", 120) } : {}),
    details: (input.details ?? []).slice(0, 30).map((detail) => ({
      label: cleanText(detail.label, "Detail label", 120),
      value: cleanText(detail.value, "Detail value", 500),
    })),
    activity,
  };

  rawRun(
    /*sql*/ `INSERT INTO artifacts (
      id, brand_id, resource_type, resource_id, artifact_type,
      metadata_json, created_at, updated_at
    ) VALUES (?, ?, 'farm_record', ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      brand_id = excluded.brand_id,
      artifact_type = excluded.artifact_type,
      metadata_json = excluded.metadata_json,
      is_archived = 0,
      updated_at = excluded.updated_at`,
    artifactId,
    farmId,
    resourceId,
    `farm_${categoryKey(input.category)}`,
    JSON.stringify(metadata),
    current?.createdAt ?? now,
    now,
  );

  const record = toFarmRecord(getArtifact(artifactId));
  if (!record) {
    throw new FarmRecordStoreError(
      "invalid_record",
      "The saved farm record could not be read back.",
    );
  }
  return record;
}
