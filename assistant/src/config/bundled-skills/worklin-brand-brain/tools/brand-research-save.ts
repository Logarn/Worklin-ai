import {
  attachBrandResearch,
  BRAND_RESEARCH_VERSION,
  type BrandResearchReport,
  createDraftBrandBrain,
} from "@vellumai/retention-domain";

import {
  getStoredBrandBrain,
  saveBrandBrain,
} from "../../../../memory/brand-brain-store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

function jsonResult(value: unknown, isError = false): ToolExecutionResult {
  return { content: JSON.stringify(value, null, 2), isError };
}

function stringInput(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseReport(input: Record<string, unknown>): BrandResearchReport {
  const report = input.report;
  if (!isRecord(report)) throw new Error("A report object is required.");
  if (report.version !== BRAND_RESEARCH_VERSION) {
    throw new Error(`Report version must be ${BRAND_RESEARCH_VERSION}.`);
  }
  const query = report.query;
  if (
    !isRecord(query) ||
    typeof query.brandName !== "string" ||
    !query.brandName.trim()
  ) {
    throw new Error("The report query must include a brandName.");
  }
  for (const key of [
    "executiveSummary",
    "competitorLandscape",
    "evidence",
    "marketSignals",
    "customerSignals",
    "trendSignals",
    "gaps",
    "recommendations",
  ]) {
    if (!Array.isArray(report[key])) {
      throw new Error(`The report field ${key} must be an array.`);
    }
  }
  if (!isRecord(report.identity) || !isRecord(report.channelFindings)) {
    throw new Error("The report must include identity and channelFindings.");
  }
  if (
    !isRecord(report.safety) ||
    report.safety.readOnly !== true ||
    report.safety.publicSourcesOnly !== true ||
    report.safety.unsupportedClaimsExcluded !== true
  ) {
    throw new Error(
      "Research reports must declare read-only public-source safety flags.",
    );
  }
  return report as unknown as BrandResearchReport;
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const report = parseReport(input);
    const brandName =
      stringInput(input, "brand_name") ?? report.query.brandName;
    const websiteUrl =
      stringInput(input, "website_url") ?? report.query.websiteUrl;
    const selector = {
      conversationId: context.conversationId,
      brandId: stringInput(input, "brand_id"),
      brandName,
      websiteUrl,
    };
    const stored = getStoredBrandBrain(selector);
    const base =
      stored?.brain ??
      createDraftBrandBrain({
        brandName,
        websiteUrl,
      });
    const next = attachBrandResearch(base, report);
    const saved = saveBrandBrain({
      brain: next,
      source: "research",
      conversationId: context.conversationId,
      eventType: "brand_research_completed",
      eventPayload: {
        evidenceCount: report.evidence.length,
        competitorCount: report.competitorLandscape.length,
      },
    });
    return jsonResult({
      saved: true,
      brandId: saved.brandId,
      revision: saved.revision,
      researchVersion: report.version,
      evidenceCount: report.evidence.length,
    });
  } catch (error) {
    return jsonResult(
      { error: error instanceof Error ? error.message : String(error) },
      true,
    );
  }
}
