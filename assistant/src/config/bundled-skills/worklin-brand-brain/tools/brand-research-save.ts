import {
  attachBrandResearch,
  BRAND_INTELLIGENCE_CONTRACT_VERSION,
  BRAND_INTELLIGENCE_MODULES,
  BRAND_RESEARCH_VERSION,
  type BrandIntelligence,
  type BrandIntelligenceQualityResult,
  createDraftBrandBrain,
  evaluateBrandIntelligenceQuality,
} from "@vellumai/retention-domain";

import {
  BRAND_RESEARCH_VISUAL_EVIDENCE_KINDS,
  type BrandResearchDocumentReport,
  brandResearchDocumentSurfaceId,
  countBrandResearchDocumentWords,
  countBrandResearchVisualEvidence,
  normalizeBrandResearchVisualUrl,
  renderBrandResearchDocument,
} from "../../../../documents/brand-research-document.js";
import { saveDocument } from "../../../../documents/document-store.js";
import { updateArtifact } from "../../../../memory/artifact-store.js";
import {
  deriveRetentionBrandId,
  getStoredBrandBrain,
  saveBrandBrain,
} from "../../../../memory/brand-brain-store.js";
import {
  brandResearchSnapshotId,
  saveBrandResearchSnapshot,
} from "../../../../memory/brand-research-snapshot-store.js";
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

function requireStringArray(value: unknown, field: string): void {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`The report field ${field} must be a string array.`);
  }
}

function requireString(
  value: unknown,
  field: string,
  allowEmpty = false,
): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`The report field ${field} must be a string.`);
  }
}

function requirePublicUrl(value: unknown, field: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a public source URL.`);
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error(`${field} must be a valid public HTTP URL.`);
  }
}

const MAX_VISUAL_EVIDENCE_PER_KIND = 6;
const MAX_VISUAL_EVIDENCE_TOTAL = 24;
const MAX_VISUAL_EVIDENCE_CAVEATS = 5;
const MAX_VISUAL_EVIDENCE_IDS = 8;
const VISUAL_EVIDENCE_ITEM_FIELDS = new Set([
  "id",
  "module",
  "kind",
  "title",
  "sourceUrl",
  "mediaUrl",
  "thumbnailUrl",
  "mediaType",
  "observedAt",
  "provider",
  "evidenceIds",
  "caption",
  "caveats",
]);

function requireBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
): asserts value is string {
  requireString(value, field);
  if (value.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters.`);
  }
}

function observedDay(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function validateVisualEvidence(
  report: Record<string, unknown>,
  evidenceById: Map<string, Record<string, unknown>>,
): void {
  if (report.visualEvidence === undefined) return;
  if (!Array.isArray(report.visualEvidence)) {
    throw new Error("The report field visualEvidence must be an array.");
  }
  if (report.visualEvidence.length > MAX_VISUAL_EVIDENCE_TOTAL) {
    throw new Error(
      `visualEvidence may include at most ${MAX_VISUAL_EVIDENCE_TOTAL} items in total.`,
    );
  }

  const kinds = new Set<string>(
    BRAND_RESEARCH_VISUAL_EVIDENCE_KINDS.map(({ kind }) => kind),
  );
  const kindCounts = new Map<string, number>();
  const visualIds = new Set<string>();
  for (const [index, item] of report.visualEvidence.entries()) {
    const field = `visualEvidence[${index}]`;
    if (!isRecord(item)) {
      throw new Error(`${field} must be an object.`);
    }
    for (const itemKey of Object.keys(item)) {
      if (!VISUAL_EVIDENCE_ITEM_FIELDS.has(itemKey)) {
        throw new Error(`${field} contains unsupported field ${itemKey}.`);
      }
    }
    requireBoundedString(item.id, `${field}.id`, 128);
    if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(item.id)) {
      throw new Error(`${field}.id must be a stable visual evidence ID.`);
    }
    if (visualIds.has(item.id)) {
      throw new Error(`Visual evidence ID ${item.id} is duplicated.`);
    }
    visualIds.add(item.id);

    if (
      item.module !== undefined &&
      (typeof item.module !== "string" ||
        !(BRAND_INTELLIGENCE_MODULES as readonly string[]).includes(
          item.module,
        ))
    ) {
      throw new Error(`${field}.module must be a supported research module.`);
    }
    if (typeof item.kind !== "string" || !kinds.has(item.kind)) {
      throw new Error(
        `${field}.kind must be a supported visual evidence kind.`,
      );
    }
    const kindCount = (kindCounts.get(item.kind) ?? 0) + 1;
    if (kindCount > MAX_VISUAL_EVIDENCE_PER_KIND) {
      throw new Error(
        `visualEvidence may include at most ${MAX_VISUAL_EVIDENCE_PER_KIND} ${item.kind} items.`,
      );
    }
    kindCounts.set(item.kind, kindCount);

    requireBoundedString(item.title, `${field}.title`, 200);
    if (item.caption !== undefined) {
      requireBoundedString(item.caption, `${field}.caption`, 800);
    }
    if (
      !Array.isArray(item.caveats) ||
      item.caveats.length > MAX_VISUAL_EVIDENCE_CAVEATS
    ) {
      throw new Error(
        `${field}.caveats must contain at most ${MAX_VISUAL_EVIDENCE_CAVEATS} strings.`,
      );
    }
    for (const [caveatIndex, caveat] of item.caveats.entries()) {
      requireBoundedString(caveat, `${field}.caveats[${caveatIndex}]`, 500);
    }

    const sourceUrl = normalizeBrandResearchVisualUrl(item.sourceUrl);
    if (!sourceUrl) {
      throw new Error(
        `${field}.sourceUrl must be a credential-free public HTTP URL.`,
      );
    }
    for (const urlField of ["mediaUrl", "thumbnailUrl"] as const) {
      if (
        item[urlField] !== undefined &&
        !normalizeBrandResearchVisualUrl(item[urlField])
      ) {
        throw new Error(
          `${field}.${urlField} must be a credential-free public HTTP URL.`,
        );
      }
    }
    if (
      item.mediaType !== undefined &&
      item.mediaType !== "image" &&
      item.mediaType !== "video" &&
      item.mediaType !== "page"
    ) {
      throw new Error(`${field}.mediaType must be image, video, or page.`);
    }
    requireString(item.observedAt, `${field}.observedAt`);
    if (!Number.isFinite(Date.parse(item.observedAt))) {
      throw new Error(`${field}.observedAt must be a valid date.`);
    }
    if (item.provider !== undefined) {
      requireBoundedString(item.provider, `${field}.provider`, 64);
      if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(item.provider)) {
        throw new Error(`${field}.provider must be a provider identifier.`);
      }
    }
    if (
      !Array.isArray(item.evidenceIds) ||
      item.evidenceIds.length === 0 ||
      item.evidenceIds.length > MAX_VISUAL_EVIDENCE_IDS
    ) {
      throw new Error(
        `${field}.evidenceIds must contain between 1 and ${MAX_VISUAL_EVIDENCE_IDS} evidence IDs.`,
      );
    }
    const linkedEvidence: Record<string, unknown>[] = [];
    const itemEvidenceIds = new Set<string>();
    for (const [evidenceIndex, evidenceId] of item.evidenceIds.entries()) {
      requireBoundedString(
        evidenceId,
        `${field}.evidenceIds[${evidenceIndex}]`,
        128,
      );
      if (itemEvidenceIds.has(evidenceId)) {
        throw new Error(
          `${field}.evidenceIds contains duplicate ${evidenceId}.`,
        );
      }
      itemEvidenceIds.add(evidenceId);
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) {
        throw new Error(
          `${field}.evidenceIds references unknown evidence ID ${evidenceId}.`,
        );
      }
      linkedEvidence.push(evidence);
    }
    const sourceEvidence = linkedEvidence.find(
      (evidence) => normalizeBrandResearchVisualUrl(evidence.url) === sourceUrl,
    );
    if (!sourceEvidence) {
      throw new Error(
        `${field}.sourceUrl must match one of its linked evidence URLs.`,
      );
    }
    if (item.provider !== undefined) {
      const expectedProvider =
        typeof sourceEvidence.provider === "string"
          ? sourceEvidence.provider
          : "public-web";
      if (item.provider !== expectedProvider) {
        throw new Error(
          `${field}.provider must match linked evidence provider ${expectedProvider}.`,
        );
      }
    }
    if (
      typeof sourceEvidence.observedAt !== "string" ||
      observedDay(sourceEvidence.observedAt) !== observedDay(item.observedAt)
    ) {
      throw new Error(
        `${field}.observedAt must match its linked evidence observation date.`,
      );
    }
  }
}

function parseDeepIntelligence(
  report: Record<string, unknown>,
): BrandIntelligence | undefined {
  if (report.intelligence === undefined) return undefined;
  if (!isRecord(report.intelligence)) {
    throw new Error("The report field intelligence must be an object.");
  }
  const intelligence = report.intelligence;
  if (
    intelligence.contractVersion !== BRAND_INTELLIGENCE_CONTRACT_VERSION ||
    intelligence.researchMode !== "deep"
  ) {
    throw new Error(
      `Deep research must use ${BRAND_INTELLIGENCE_CONTRACT_VERSION}.`,
    );
  }
  requireString(intelligence.brandId, "intelligence.brandId");
  if (!isRecord(intelligence.scope)) {
    throw new Error("The report field intelligence.scope must be an object.");
  }
  for (const key of ["businessQuestions", "geographies", "languages"]) {
    requireStringArray(intelligence.scope[key], `intelligence.scope.${key}`);
  }
  requireString(intelligence.scope.periodEnd, "intelligence.scope.periodEnd");
  for (const key of [
    "modules",
    "claims",
    "evidenceAssessments",
    "hypotheses",
    "metrics",
    "contradictions",
    "visualizations",
    "recommendations",
    "limitations",
  ]) {
    if (!Array.isArray(intelligence[key])) {
      throw new Error(`The report field intelligence.${key} must be an array.`);
    }
  }
  return intelligence as unknown as BrandIntelligence;
}

function parseReport(
  input: Record<string, unknown>,
): BrandResearchDocumentReport {
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
  if (
    typeof report.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(report.generatedAt))
  ) {
    throw new Error("The report must include a valid generatedAt timestamp.");
  }
  if (query.websiteUrl !== undefined) {
    requirePublicUrl(query.websiteUrl, "query.websiteUrl");
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
  const evidenceItems = report.evidence as unknown[];
  const competitors = report.competitorLandscape as unknown[];
  const gaps = report.gaps as unknown[];
  if (competitors.length > 3) {
    throw new Error(
      "The report may include at most three deep competitor dossiers.",
    );
  }
  if (!isRecord(report.identity) || !isRecord(report.channelFindings)) {
    throw new Error("The report must include identity and channelFindings.");
  }
  requireString(report.identity.category, "identity.category", true);
  requireString(report.identity.positioning, "identity.positioning", true);
  requireStringArray(report.executiveSummary, "executiveSummary");
  requireStringArray(report.identity.offers, "identity.offers");
  requireStringArray(
    report.identity.audienceSignals,
    "identity.audienceSignals",
  );
  for (const key of [
    "seoAndContent",
    "social",
    "emailAndLifecycle",
    "sms",
    "productAndLaunches",
  ]) {
    requireStringArray(report.channelFindings[key], `channelFindings.${key}`);
  }
  for (const key of [
    "marketSignals",
    "customerSignals",
    "trendSignals",
    "gaps",
  ]) {
    requireStringArray(report[key], key);
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
  requireStringArray(report.safety.caveats, "safety.caveats");

  const evidenceIds = new Set<string>();
  const evidenceById = new Map<string, Record<string, unknown>>();
  for (const [index, evidence] of evidenceItems.entries()) {
    if (!isRecord(evidence)) {
      throw new Error(`Evidence item ${index + 1} must be an object.`);
    }
    for (const key of ["id", "title", "sourceType", "observedAt", "finding"]) {
      if (typeof evidence[key] !== "string" || !evidence[key].trim()) {
        throw new Error(`Evidence item ${index + 1} is missing ${key}.`);
      }
    }
    requirePublicUrl(evidence.url, `evidence[${index}].url`);
    if (!Number.isFinite(Date.parse(evidence.observedAt as string))) {
      throw new Error(
        `Evidence item ${index + 1} must include a valid observedAt date.`,
      );
    }
    if (
      evidence.confidence !== "high" &&
      evidence.confidence !== "medium" &&
      evidence.confidence !== "low"
    ) {
      throw new Error(
        `Evidence item ${index + 1} must include a valid confidence.`,
      );
    }
    if (evidenceIds.has(evidence.id as string)) {
      throw new Error(`Evidence ID ${evidence.id as string} is duplicated.`);
    }
    evidenceIds.add(evidence.id as string);
    evidenceById.set(evidence.id as string, evidence);
  }
  validateVisualEvidence(report, evidenceById);
  parseDeepIntelligence(report);
  if (evidenceItems.length === 0 && gaps.length === 0) {
    throw new Error(
      "A report without evidence must explicitly record its research gaps.",
    );
  }
  for (const [index, competitor] of competitors.entries()) {
    if (!isRecord(competitor)) {
      throw new Error(`Competitor ${index + 1} must include a name.`);
    }
    requireString(competitor.name, `competitorLandscape[${index}].name`);
    requireString(
      competitor.positioning,
      `competitorLandscape[${index}].positioning`,
      true,
    );
    if (
      competitor.classification !== undefined &&
      competitor.classification !== "direct" &&
      competitor.classification !== "adjacent" &&
      competitor.classification !== "substitute" &&
      competitor.classification !== "aspirational"
    ) {
      throw new Error(
        `Competitor ${index + 1} must include a valid classification.`,
      );
    }
    if (competitor.rationale !== undefined) {
      requireString(
        competitor.rationale,
        `competitorLandscape[${index}].rationale`,
        true,
      );
    }
    if (competitor.websiteUrl !== undefined) {
      requirePublicUrl(
        competitor.websiteUrl,
        `competitorLandscape[${index}].websiteUrl`,
      );
    }
    if (competitor.pricingPosture !== undefined) {
      requireString(
        competitor.pricingPosture,
        `competitorLandscape[${index}].pricingPosture`,
        true,
      );
    }
    for (const key of ["offers", "differentiators", "gaps"]) {
      if (competitor[key] !== undefined) {
        requireStringArray(
          competitor[key],
          `competitorLandscape[${index}].${key}`,
        );
      }
    }
    if (competitor.channelSignals !== undefined) {
      if (!isRecord(competitor.channelSignals)) {
        throw new Error(
          `Competitor ${index + 1} channelSignals must be an object.`,
        );
      }
      for (const key of [
        "paidMedia",
        "social",
        "seoAndContent",
        "emailAndLifecycle",
      ]) {
        requireStringArray(
          competitor.channelSignals[key],
          `competitorLandscape[${index}].channelSignals.${key}`,
        );
      }
    }
    requireStringArray(
      competitor.notableMoves,
      `competitorLandscape[${index}].notableMoves`,
    );
    requireStringArray(
      competitor.evidenceIds,
      `competitorLandscape[${index}].evidenceIds`,
    );
    if (
      competitor.confidence !== "high" &&
      competitor.confidence !== "medium" &&
      competitor.confidence !== "low"
    ) {
      throw new Error(
        `Competitor ${index + 1} must include a valid confidence.`,
      );
    }
    for (const evidenceId of competitor.evidenceIds as string[]) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(
          `Competitor ${index + 1} references unknown evidence ID ${evidenceId}.`,
        );
      }
    }
  }
  for (const [index, recommendation] of (
    report.recommendations as unknown[]
  ).entries()) {
    if (!isRecord(recommendation)) {
      throw new Error(`Recommendation ${index + 1} must be an object.`);
    }
    if (
      recommendation.priority !== "now" &&
      recommendation.priority !== "next" &&
      recommendation.priority !== "later"
    ) {
      throw new Error(
        `Recommendation ${index + 1} must include a valid priority.`,
      );
    }
    requireString(recommendation.action, `recommendations[${index}].action`);
    requireString(
      recommendation.rationale,
      `recommendations[${index}].rationale`,
    );
    requireStringArray(
      recommendation.evidenceIds,
      `recommendations[${index}].evidenceIds`,
    );
    for (const evidenceId of recommendation.evidenceIds as string[]) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(
          `Recommendation ${index + 1} references unknown evidence ID ${evidenceId}.`,
        );
      }
    }
  }
  return report as unknown as BrandResearchDocumentReport;
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  try {
    const report = parseReport(input);
    const intelligence = report.intelligence;
    const brandName =
      stringInput(input, "brand_name") ?? report.query.brandName;
    const websiteUrl =
      stringInput(input, "website_url") ?? report.query.websiteUrl;
    const explicitBrandId = stringInput(input, "brand_id");
    let quality: BrandIntelligenceQualityResult | undefined;
    if (intelligence) {
      if (!explicitBrandId) {
        throw new Error(
          "Deep Brand Intelligence requires the stable brand_id created during onboarding.",
        );
      }
      if (intelligence.brandId !== explicitBrandId) {
        throw new Error(
          "The deep report brandId does not match the requested brand_id.",
        );
      }
      const unscopedVisuals = (report.visualEvidence ?? []).filter(
        (item) => item.module === undefined,
      );
      if (unscopedVisuals.length > 0) {
        throw new Error(
          "Every visual evidence item in a deep report must name its research module.",
        );
      }
      try {
        quality = evaluateBrandIntelligenceQuality(
          intelligence,
          report.evidence.map((item) => item.id),
          { visualEvidence: report.visualEvidence },
        );
      } catch (error) {
        throw new Error(
          `Deep Brand Intelligence contract is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const selector = {
      conversationId: context.conversationId,
      brandId: explicitBrandId,
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
    const visualEvidenceCount = countBrandResearchVisualEvidence(report);
    const targetBrandId =
      explicitBrandId ?? stored?.brandId ?? deriveRetentionBrandId(next);
    const snapshotId = brandResearchSnapshotId({
      brandId: targetBrandId,
      report,
      quality,
    });
    const saved = saveBrandBrain({
      brain: next,
      brandId: targetBrandId,
      source: "research",
      conversationId: context.conversationId,
      eventType:
        quality && !quality.accepted
          ? "brand_research_partial"
          : "brand_research_completed",
      eventPayload: {
        evidenceCount: report.evidence.length,
        competitorCount: report.competitorLandscape.length,
        visualEvidenceCount,
        qualityAccepted: quality?.accepted ?? null,
        qualityScore: quality?.score ?? null,
        snapshotId,
      },
    });
    const snapshot = saveBrandResearchSnapshot({
      brandId: saved.brandId,
      report,
      quality,
    });
    const surfaceId = brandResearchDocumentSurfaceId(saved.brandId);
    const title = intelligence
      ? "Brand Intelligence"
      : "Competitor Intelligence";
    const artifactType = intelligence
      ? "brand_intelligence"
      : "competitor_intelligence";
    const content = renderBrandResearchDocument(report);
    const documentResult = saveDocument({
      surfaceId,
      conversationId: context.conversationId,
      title,
      content,
      wordCount: countBrandResearchDocumentWords(content),
    });
    if (!documentResult.success) {
      return jsonResult(
        {
          saved: true,
          artifactSaved: false,
          brandId: saved.brandId,
          revision: saved.revision,
          error: `Brand Brain was saved, but the Work artifact could not be saved: ${documentResult.error}`,
        },
        true,
      );
    }
    const artifactId = `document:${surfaceId}`;
    try {
      updateArtifact(artifactId, {
        brandId: saved.brandId,
        artifactType,
        metadata: {
          title,
          description: intelligence
            ? "Source-linked brand, customer, market, channel, and competitor intelligence"
            : "Source-linked competitor, channel, offer, and market intelligence",
          generatedAt: report.generatedAt,
          snapshotId: snapshot.snapshotId,
          researchHistoryPreserved: true,
          researchVersion: report.version,
          evidenceCount: report.evidence.length,
          competitorCount: report.competitorLandscape.length,
          visualEvidenceCount,
          quality: quality ?? null,
          ...(intelligence
            ? { brandIntelligence: report }
            : { competitorIntelligence: report }),
        },
      });
    } catch (error) {
      return jsonResult(
        {
          saved: true,
          artifactSaved: false,
          brandId: saved.brandId,
          revision: saved.revision,
          error: `Brand Brain was saved, but the Work artifact could not be registered: ${error instanceof Error ? error.message : String(error)}`,
        },
        true,
      );
    }
    return jsonResult({
      saved: true,
      artifactSaved: true,
      brandId: saved.brandId,
      revision: saved.revision,
      snapshotId: snapshot.snapshotId,
      snapshotStatus: snapshot.status,
      researchVersion: report.version,
      evidenceCount: report.evidence.length,
      visualEvidenceCount,
      qualityAccepted: quality?.accepted ?? null,
      qualityScore: quality?.score ?? null,
      qualityFailures: quality?.blockingFailures ?? [],
      artifactType,
      artifactId,
      artifactSurfaceId: surfaceId,
    });
  } catch (error) {
    return jsonResult(
      { error: error instanceof Error ? error.message : String(error) },
      true,
    );
  }
}
