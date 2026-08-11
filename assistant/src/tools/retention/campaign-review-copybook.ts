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
    memberCount?: number;
    eligibleCount?: number;
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
      title: campaign.title,
      metadata: {
        source: "retention_segment_run",
        runId: input.runId,
        sourceIndex,
        reviewOnly: true,
        ...(campaign.memberCount !== undefined
          ? { memberCount: campaign.memberCount }
          : {}),
        ...(campaign.eligibleCount !== undefined
          ? { eligibleCount: campaign.eligibleCount }
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
