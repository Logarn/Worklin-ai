import type { ArtifactSummary } from "./use-work-data";

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

export type FarmRecordCategory = (typeof FARM_RECORD_CATEGORIES)[number];
export type FarmRecordAttentionLevel = "normal" | "watch" | "action" | "urgent";
export type FarmRecordActivityState = "done" | "current" | "pending";

export interface FarmRecordDetail {
  label: string;
  value: string;
}

export interface FarmRecordActivity {
  at: string;
  label: string;
  state: FarmRecordActivityState;
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

function isCategory(value: unknown): value is FarmRecordCategory {
  return FARM_RECORD_CATEGORIES.includes(value as FarmRecordCategory);
}

function isAttentionLevel(value: unknown): value is FarmRecordAttentionLevel {
  return ["normal", "watch", "action", "urgent"].includes(String(value));
}

function isActivityState(value: unknown): value is FarmRecordActivityState {
  return ["done", "current", "pending"].includes(String(value));
}

function parseDetails(value: unknown): FarmRecordDetail[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const detail = item as Record<string, unknown>;
    return typeof detail.label === "string" && typeof detail.value === "string"
      ? [{ label: detail.label, value: detail.value }]
      : [];
  });
}

function parseActivity(value: unknown): FarmRecordActivity[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const activity = item as Record<string, unknown>;
    return typeof activity.at === "string" &&
      typeof activity.label === "string" &&
      isActivityState(activity.state)
      ? [
          {
            at: activity.at,
            label: activity.label,
            state: activity.state,
          },
        ]
      : [];
  });
}

export function parseFarmRecordArtifact(
  artifact: ArtifactSummary,
): FarmRecord | null {
  const metadata = artifact.metadata;
  if (
    artifact.resourceType !== "farm_record" ||
    !artifact.brandId ||
    metadata?.contractVersion !== FARM_RECORD_CONTRACT_VERSION ||
    typeof metadata.recordId !== "string" ||
    typeof metadata.title !== "string" ||
    typeof metadata.reference !== "string" ||
    !isCategory(metadata.category) ||
    typeof metadata.recordType !== "string" ||
    typeof metadata.status !== "string" ||
    typeof metadata.summary !== "string" ||
    !isAttentionLevel(metadata.attentionLevel)
  ) {
    return null;
  }

  return {
    artifactId: artifact.id,
    brandId: artifact.brandId,
    recordId: metadata.recordId,
    title: metadata.title,
    reference: metadata.reference,
    category: metadata.category,
    recordType: metadata.recordType,
    status: metadata.status,
    summary: metadata.summary,
    attentionLevel: metadata.attentionLevel,
    ...(typeof metadata.occurredAt === "string"
      ? { occurredAt: metadata.occurredAt }
      : {}),
    ...(typeof metadata.amount === "string" ? { amount: metadata.amount } : {}),
    details: parseDetails(metadata.details),
    activity: parseActivity(metadata.activity),
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

export function getFarmRecords(
  artifacts: readonly ArtifactSummary[],
  brandId: string,
): FarmRecord[] {
  return artifacts
    .filter((artifact) => artifact.brandId === brandId)
    .map(parseFarmRecordArtifact)
    .filter((record): record is FarmRecord => record !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
