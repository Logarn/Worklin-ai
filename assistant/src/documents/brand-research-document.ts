import type { BrandResearchReport } from "@vellumai/retention-domain";

export const BRAND_RESEARCH_VISUAL_EVIDENCE_KINDS = [
  { kind: "ad", label: "Ads" },
  { kind: "email", label: "Emails" },
  { kind: "social", label: "Social Posts" },
  { kind: "product", label: "Products" },
  { kind: "landing_page", label: "Landing Pages" },
  { kind: "brand", label: "Brand" },
  { kind: "competitor", label: "Competitors" },
] as const;

export type BrandResearchVisualEvidenceKind =
  (typeof BRAND_RESEARCH_VISUAL_EVIDENCE_KINDS)[number]["kind"];

export interface BrandResearchVisualEvidenceItem {
  id: string;
  kind: BrandResearchVisualEvidenceKind;
  title: string;
  sourceUrl: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  mediaType?: "image" | "video" | "page";
  observedAt: string;
  provider?: string;
  evidenceIds: string[];
  caption?: string;
  caveats: string[];
}

export type BrandResearchDocumentReport = BrandResearchReport & {
  visualEvidence?: BrandResearchVisualEvidenceItem[];
};

const SENSITIVE_URL_PARAMETER =
  /^(?:access[-_]?token|api[-_]?key|apikey|auth|authorization|bearer|client[-_]?secret|credential|credentials|key|password|secret|session|signature|sig|token|x-amz-credential|x-amz-security-token|x-amz-signature|x-goog-credential|x-goog-signature)$/i;

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isIpv6 = host.includes(":");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "::1" ||
    (isIpv6 &&
      (host.startsWith("fc") ||
        host.startsWith("fd") ||
        host.startsWith("fe80:")))
  ) {
    return false;
  }
  const octets = host.split(".").map(Number);
  if (
    octets.length === 4 &&
    octets.every(
      (octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
    )
  ) {
    const [first, second] = octets as [number, number, number, number];
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }
  return host.length > 0;
}

function hasSensitiveParameters(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_URL_PARAMETER.test(key)) return true;
  }
  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (!fragment.includes("=")) return false;
  for (const key of new URLSearchParams(fragment).keys()) {
    if (SENSITIVE_URL_PARAMETER.test(key)) return true;
  }
  return false;
}

export function normalizeBrandResearchVisualUrl(
  value: unknown,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      !isPublicHostname(parsed.hostname) ||
      hasSensitiveParameters(parsed)
    ) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function bulletList(
  values: string[],
  empty = "No evidence-backed finding was saved.",
): string {
  return values.length > 0
    ? values.map((value) => `- ${compact(value)}`).join("\n")
    : `- ${empty}`;
}

function optionalLink(label: string, url: string | undefined): string {
  if (!url) return compact(label);
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return `[${compact(label)}](${parsed.toString()})`;
    }
  } catch {
    // Invalid URLs are shown as text instead of becoming clickable content.
  }
  return compact(label);
}

function markdownText(value: string): string {
  return compact(value)
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]<>|])/g, "\\$1");
}

function markdownAltText(value: string): string {
  return compact(value).replace(/\\/g, "\\\\").replace(/[[\]]/g, "\\$&");
}

function markdownUrl(value: string): string {
  return value.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function renderVisualEvidenceItem(
  item: BrandResearchVisualEvidenceItem,
): string | null {
  const sourceUrl = normalizeBrandResearchVisualUrl(item.sourceUrl);
  if (!sourceUrl) return null;
  const mediaUrl = normalizeBrandResearchVisualUrl(item.mediaUrl);
  const thumbnailUrl = normalizeBrandResearchVisualUrl(item.thumbnailUrl);
  const previewUrl =
    thumbnailUrl ?? (item.mediaType === "video" ? undefined : mediaUrl);
  return [
    `#### ${optionalLink(markdownText(item.title), markdownUrl(sourceUrl))}`,
    "",
    previewUrl
      ? `[![${markdownAltText(item.title)}](${markdownUrl(previewUrl)})](${markdownUrl(sourceUrl)})`
      : null,
    item.mediaType === "video" && mediaUrl
      ? `[Open video media](${markdownUrl(mediaUrl)})`
      : null,
    "",
    item.caption ? markdownText(item.caption) : null,
    "",
    `- **Observed:** ${markdownText(item.observedAt)}`,
    `- **Provider:** \`${item.provider ?? "public-web"}\``,
    `- **Evidence:** ${item.evidenceIds.map((id) => `\`${id}\``).join(", ")}`,
    ...item.caveats.map((caveat) => `- **Caveat:** ${markdownText(caveat)}`),
  ]
    .filter((value): value is string => value !== null)
    .join("\n");
}

function renderVisualEvidence(report: BrandResearchDocumentReport): string {
  const groups = BRAND_RESEARCH_VISUAL_EVIDENCE_KINDS.flatMap(
    ({ kind, label }) => {
      const items = (report.visualEvidence ?? [])
        .filter((item) => item.kind === kind)
        .map(renderVisualEvidenceItem)
        .filter((item): item is string => item !== null);
      if (items.length === 0) return [];
      return [[`### ${label}`, "", items.join("\n\n---\n\n")].join("\n")];
    },
  );
  if (groups.length === 0) {
    return "No visual previews were saved for this report. The written findings and Evidence Ledger remain available below.";
  }
  return [
    "Each preview links to its public source. Provider observations remain evidence, not verified performance results.",
    "",
    groups.join("\n\n"),
  ].join("\n");
}

function renderCompetitors(report: BrandResearchDocumentReport): string {
  if (report.competitorLandscape.length === 0) {
    return "- No evidence-backed competitor was identified.";
  }
  return report.competitorLandscape
    .map((competitor) => {
      const channels = competitor.channelSignals;
      return [
        `### ${optionalLink(competitor.name, competitor.websiteUrl)}`,
        "",
        competitor.classification
          ? `**Class:** ${competitor.classification}`
          : null,
        competitor.rationale
          ? `**Why it belongs:** ${compact(competitor.rationale)}`
          : null,
        `**Positioning:** ${compact(competitor.positioning) || "Unknown"}`,
        "",
        competitor.pricingPosture
          ? `**Pricing posture:** ${compact(competitor.pricingPosture)}`
          : null,
        competitor.offers
          ? ["**Offers**", "", bulletList(competitor.offers), ""].join("\n")
          : null,
        competitor.differentiators
          ? [
              "**Visible differentiation**",
              "",
              bulletList(competitor.differentiators),
              "",
            ].join("\n")
          : null,
        channels
          ? [
              "**Channel signals**",
              "",
              "#### Paid media",
              "",
              bulletList(channels.paidMedia),
              "",
              "#### Social",
              "",
              bulletList(channels.social),
              "",
              "#### SEO and content",
              "",
              bulletList(channels.seoAndContent),
              "",
              "#### Email and lifecycle",
              "",
              bulletList(channels.emailAndLifecycle),
              "",
            ].join("\n")
          : null,
        "**Notable moves**",
        "",
        bulletList(competitor.notableMoves),
        "",
        competitor.gaps
          ? [
              "**Research gaps**",
              "",
              bulletList(competitor.gaps, "No material gap was recorded."),
              "",
            ].join("\n")
          : null,
        `**Evidence:** ${competitor.evidenceIds.length > 0 ? competitor.evidenceIds.map((id) => `\`${id}\``).join(", ") : "No linked evidence"}`,
        "",
        `**Confidence:** ${competitor.confidence}`,
      ]
        .filter((value): value is string => value !== null)
        .join("\n");
    })
    .join("\n\n");
}

function renderRecommendations(report: BrandResearchDocumentReport): string {
  if (report.recommendations.length === 0) {
    return "- No recommendation was made without stronger evidence.";
  }
  return report.recommendations
    .map((recommendation) =>
      [
        `### ${recommendation.priority.toUpperCase()}: ${compact(recommendation.action)}`,
        "",
        compact(recommendation.rationale),
        "",
        `**Evidence:** ${recommendation.evidenceIds.length > 0 ? recommendation.evidenceIds.map((id) => `\`${id}\``).join(", ") : "No linked evidence"}`,
      ].join("\n"),
    )
    .join("\n\n");
}

function renderEvidence(report: BrandResearchDocumentReport): string {
  if (report.evidence.length === 0) {
    return "- No public evidence was observable. See Research Gaps.";
  }
  return report.evidence
    .map((evidence) =>
      [
        `### \`${evidence.id}\` - ${optionalLink(evidence.title, evidence.url)}`,
        "",
        `- **Observed:** ${compact(evidence.observedAt)}`,
        `- **Source type:** ${evidence.sourceType}`,
        `- **Provider:** ${evidence.provider ?? "public-web"}`,
        `- **Confidence:** ${evidence.confidence}`,
        `- **Finding:** ${compact(evidence.finding)}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export function brandResearchDocumentSurfaceId(brandId: string): string {
  return `brand-research:${brandId}`;
}

export function countBrandResearchDocumentWords(content: string): number {
  const trimmed = content.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function countBrandResearchVisualEvidence(
  report: BrandResearchDocumentReport,
): number {
  return report.visualEvidence?.length ?? 0;
}

export function renderBrandResearchDocument(
  report: BrandResearchDocumentReport,
): string {
  const identity = report.identity;
  const channels = report.channelFindings;
  return [
    `# ${compact(report.query.brandName)} Brand Research`,
    "",
    `Generated ${compact(report.generatedAt)} from public, read-only evidence. Any provider-backed observations are labeled in the evidence ledger.`,
    "",
    "> This report contains observations and qualified inferences. It does not turn research into approved brand claims.",
    "",
    "## Executive Summary",
    "",
    bulletList(report.executiveSummary),
    "",
    "## Visual Evidence Gallery",
    "",
    renderVisualEvidence(report),
    "",
    "## Brand Identity And Offers",
    "",
    `**Category:** ${compact(identity.category) || "Unknown"}`,
    "",
    `**Positioning:** ${compact(identity.positioning) || "Unknown"}`,
    "",
    "**Offers**",
    "",
    bulletList(identity.offers),
    "",
    "**Audience signals**",
    "",
    bulletList(identity.audienceSignals),
    "",
    "## Competitor Landscape",
    "",
    renderCompetitors(report),
    "",
    "## SEO And Content",
    "",
    bulletList(channels.seoAndContent),
    "",
    "## Public Social Footprint",
    "",
    bulletList(channels.social),
    "",
    "## Email And Lifecycle",
    "",
    bulletList(channels.emailAndLifecycle),
    "",
    "## SMS",
    "",
    bulletList(channels.sms),
    "",
    "## Products And Launches",
    "",
    bulletList(channels.productAndLaunches),
    "",
    "## Customer Signals",
    "",
    bulletList(report.customerSignals),
    "",
    "## Market And Investor Signals",
    "",
    bulletList(report.marketSignals),
    "",
    "## Trend Signals",
    "",
    bulletList(report.trendSignals),
    "",
    "## Recommendations",
    "",
    renderRecommendations(report),
    "",
    "## Research Gaps",
    "",
    bulletList(report.gaps, "No unresolved coverage gap was recorded."),
    "",
    "## Evidence Ledger",
    "",
    renderEvidence(report),
    "",
    "## Safety And Provenance",
    "",
    `- Read-only research: ${report.safety.readOnly ? "yes" : "no"}`,
    `- Public sources only: ${report.safety.publicSourcesOnly ? "yes" : "no"}`,
    `- Unsupported claims excluded: ${report.safety.unsupportedClaimsExcluded ? "yes" : "no"}`,
    ...report.safety.caveats.map((caveat) => `- ${compact(caveat)}`),
  ].join("\n");
}
