import type {
  BrandBrainCampaignLearning,
  BrandBrainCorrection,
  BrandBrainCorrectionField,
} from "@vellumai/retention-domain";

import {
  applyStoredBrandBrainCorrection,
  bindConversationToBrand,
  getStoredBrandBrain,
  listStoredBrandBrains,
  recordStoredBrandBrainCampaignLearning,
} from "../../memory/brand-brain-store.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

const CORRECTION_FIELDS = new Set<BrandBrainCorrectionField>([
  "voice_summary",
  "tagline",
  "brand_story",
  "unique_selling_proposition",
  "rule_do",
  "rule_dont",
  "approved_phrase",
  "avoid_phrase",
  "approved_cta",
  "audience_note",
  "required_disclaimer",
  "forbidden_claim",
  "caution_area",
]);

function stringInput(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function selector(input: Record<string, unknown>, context: ToolContext) {
  return {
    conversationId: context.conversationId,
    brandId: stringInput(input, "brand_id"),
    brandName: stringInput(input, "brand_name"),
    websiteUrl: stringInput(input, "website_url"),
  };
}

function jsonResult(value: unknown, isError = false): ToolExecutionResult {
  return { content: JSON.stringify(value, null, 2), isError };
}

function storedResult(stored: ReturnType<typeof getStoredBrandBrain>) {
  if (!stored) return undefined;
  return {
    storage: {
      brandId: stored.brandId,
      revision: stored.revision,
      source: stored.source,
      updatedAt: new Date(stored.updatedAt).toISOString(),
    },
    profile: stored.brain,
  };
}

export async function executeBrandBrainRead(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const stored = getStoredBrandBrain(selector(input, context));
    if (!stored) {
      return jsonResult(
        {
          error:
            "No unambiguous persisted Brand Brain matched this conversation or selector.",
          availableBrands: listStoredBrandBrains().map((profile) => ({
            brandId: profile.brandId,
            brandName: profile.brain.brandName,
            websiteUrl: profile.brain.websiteUrl ?? null,
          })),
        },
        true,
      );
    }
    bindConversationToBrand(context.conversationId, stored.brandId);
    return jsonResult(storedResult(stored));
  } catch (error) {
    return jsonResult(
      { error: error instanceof Error ? error.message : String(error) },
      true,
    );
  }
}

export async function executeBrandBrainApplyCorrection(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    if (input.explicitly_approved !== true) {
      return jsonResult(
        {
          error:
            "Brand Brain corrections require explicitly_approved=true after the user directly corrects or approves the rule.",
        },
        true,
      );
    }
    const field = stringInput(input, "field");
    const operation = stringInput(input, "operation");
    const value = stringInput(input, "value");
    if (!field || !CORRECTION_FIELDS.has(field as BrandBrainCorrectionField)) {
      return jsonResult(
        { error: "Unsupported Brand Brain correction field." },
        true,
      );
    }
    if (!operation || !["add", "remove", "replace"].includes(operation)) {
      return jsonResult(
        { error: "Unsupported Brand Brain correction operation." },
        true,
      );
    }
    if (!value) {
      return jsonResult({ error: "Correction value is required." }, true);
    }
    const correction: BrandBrainCorrection = {
      field: field as BrandBrainCorrectionField,
      operation: operation as BrandBrainCorrection["operation"],
      value,
      previousValue: stringInput(input, "previous_value"),
    };
    const stored = applyStoredBrandBrainCorrection({
      selector: selector(input, context),
      correction,
      conversationId: context.conversationId,
      reason: stringInput(input, "reason"),
    });
    return jsonResult(storedResult(stored));
  } catch (error) {
    return jsonResult(
      { error: error instanceof Error ? error.message : String(error) },
      true,
    );
  }
}

export async function executeBrandBrainRecordCampaignOutcome(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    if (input.result_confirmed !== true) {
      return jsonResult(
        {
          error:
            "Campaign outcomes require result_confirmed=true after the user supplies or confirms the result.",
        },
        true,
      );
    }
    const campaignType = stringInput(input, "campaign_type");
    const insight = stringInput(input, "insight");
    const outcome = stringInput(input, "outcome");
    const evidence = stringInput(input, "evidence");
    if (!campaignType || !insight || !evidence) {
      return jsonResult(
        { error: "Campaign type, insight, and evidence are required." },
        true,
      );
    }
    if (!outcome || !["winning", "mixed", "avoid"].includes(outcome)) {
      return jsonResult({ error: "Unsupported campaign outcome." }, true);
    }
    const learning: BrandBrainCampaignLearning = {
      campaignType,
      insight,
      outcome: outcome as BrandBrainCampaignLearning["outcome"],
    };
    const stored = recordStoredBrandBrainCampaignLearning({
      selector: selector(input, context),
      learning,
      conversationId: context.conversationId,
      evidence,
    });
    return jsonResult(storedResult(stored));
  } catch (error) {
    return jsonResult(
      { error: error instanceof Error ? error.message : String(error) },
      true,
    );
  }
}
