import {
  getDocumentById,
  updateDocumentContent,
} from "../../documents/document-store.js";
import { getStoredBrandBrain } from "../../memory/brand-brain-store.js";
import {
  createCopybook,
  createCopybookCampaign,
  createCopybookMonth,
  getCopybookDetail,
  listCopybooks,
} from "../../memory/copybook-store.js";
import type { ToolContext } from "../types.js";

export interface CampaignReviewCopybookInput {
  runId: string;
  brandName: string;
  markdown: string;
  campaigns: Array<{
    title: string;
    description?: string;
    confidence?: number;
    memberCount?: number;
    eligibleCount?: number;
    evidence?: unknown[];
    campaignConcept?: unknown;
    representativeMessages?: unknown[];
  }>;
}

export type CampaignReviewCopybookResult =
  | {
      saved: true;
      copybookId: string;
      monthId: string;
      documentSurfaceId: string;
      campaignsCreated: number;
    }
  | {
      saved: false;
      reason: "brand_brain_required" | "copybook_document_unavailable";
    };

export function saveCampaignReviewToCopybook(
  input: CampaignReviewCopybookInput,
  context: ToolContext,
  now = new Date(),
): CampaignReviewCopybookResult {
  const brandBrain = getStoredBrandBrain({ brandName: input.brandName });
  if (!brandBrain) {
    return { saved: false, reason: "brand_brain_required" };
  }

  const year = now.getUTCFullYear();
  const monthNumber = now.getUTCMonth() + 1;
  const copybook =
    listCopybooks({ brandId: brandBrain.brandId, year })[0] ??
    createCopybook({ brandId: brandBrain.brandId, year });
  let detail = getCopybookDetail(copybook.id);
  const month =
    detail.months.find((item) => item.month === monthNumber) ??
    createCopybookMonth({
      copybookId: copybook.id,
      month: monthNumber,
      conversationId: context.conversationId,
      title: `${input.brandName} // ${now.toLocaleString("en", {
        month: "long",
        timeZone: "UTC",
      })} ${year} Copybook`,
    });
  if (!month.documentSurfaceId) {
    return { saved: false, reason: "copybook_document_unavailable" };
  }

  const marker = `<!-- worklin-retention-segment-run:${input.runId} -->`;
  const document = getDocumentById(month.documentSurfaceId);
  if (!document) {
    return { saved: false, reason: "copybook_document_unavailable" };
  }
  if (!document.content.includes(marker)) {
    const updated = updateDocumentContent(
      month.documentSurfaceId,
      `${marker}\n${input.markdown}`,
      "append",
    );
    if (!updated.success) {
      return { saved: false, reason: "copybook_document_unavailable" };
    }
  }

  detail = getCopybookDetail(copybook.id);
  const storedMonth = detail.months.find((item) => item.id === month.id);
  const existingCampaigns = storedMonth?.campaigns ?? [];
  let nextOrdinal =
    existingCampaigns
      .filter((item) => item.channel === "email")
      .reduce((maximum, item) => Math.max(maximum, item.ordinal), 0) + 1;
  let campaignsCreated = 0;
  for (const [index, campaign] of input.campaigns.entries()) {
    const sourceIndex = index + 1;
    if (
      existingCampaigns.some(
        (item) =>
          item.metadata?.source === "retention_segment_run" &&
          item.metadata.runId === input.runId &&
          item.metadata.sourceIndex === sourceIndex,
      )
    ) {
      continue;
    }
    createCopybookCampaign({
      monthId: month.id,
      channel: "email",
      ordinal: nextOrdinal,
      title: campaignRecordTitle(campaign),
      metadata: {
        source: "retention_segment_run",
        runId: input.runId,
        sourceIndex,
        reviewOnly: true,
        microSegmentName: campaign.title,
        sampleCount: campaign.representativeMessages?.length ?? 0,
        ...(campaign.description ? { description: campaign.description } : {}),
        ...(campaign.confidence !== undefined
          ? { confidence: campaign.confidence }
          : {}),
        ...(campaign.memberCount !== undefined
          ? { memberCount: campaign.memberCount }
          : {}),
        ...(campaign.eligibleCount !== undefined
          ? { eligibleCount: campaign.eligibleCount }
          : {}),
        ...(campaign.evidence ? { evidence: campaign.evidence } : {}),
        ...(campaign.campaignConcept
          ? {
              campaignConcept: campaign.campaignConcept,
              ...campaignConceptMetadata(campaign.campaignConcept),
            }
          : {}),
        ...(campaign.representativeMessages
          ? {
              representativeMessages: campaign.representativeMessages,
              draftSubjects: draftSubjects(campaign.representativeMessages),
            }
          : {}),
      },
    });
    nextOrdinal += 1;
    campaignsCreated += 1;
  }

  return {
    saved: true,
    copybookId: copybook.id,
    monthId: month.id,
    documentSurfaceId: month.documentSurfaceId,
    campaignsCreated,
  };
}

function campaignRecordTitle(
  campaign: CampaignReviewCopybookInput["campaigns"][number],
): string {
  const concept = recordValue(campaign.campaignConcept);
  const objective = stringValue(concept.objective).trim();
  if (!objective) return campaign.title;
  return `${campaign.title} - ${objective}`.slice(0, 200);
}

function campaignConceptMetadata(value: unknown): Record<string, string> {
  const concept = recordValue(value);
  return {
    ...(stringValue(concept.objective)
      ? { campaignObjective: stringValue(concept.objective) }
      : {}),
    ...(stringValue(concept.angle)
      ? { campaignAngle: stringValue(concept.angle) }
      : {}),
    ...(stringValue(concept.timing)
      ? { campaignTiming: stringValue(concept.timing) }
      : {}),
    ...(stringValue(concept.callToAction)
      ? { campaignCallToAction: stringValue(concept.callToAction) }
      : {}),
  };
}

function draftSubjects(value: unknown[]): string[] {
  return value
    .map((item) => stringValue(recordValue(item).subject).trim())
    .filter((subject) => subject.length > 0)
    .slice(0, 5);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
