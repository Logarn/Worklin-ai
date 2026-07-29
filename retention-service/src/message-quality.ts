export type MessageQualityField = "subject" | "preheader" | "body" | "offer";

export type MessageQualitySeverity = "blocking" | "warning";

export type MessageQualityCode =
  | "empty_content"
  | "low_information"
  | "gibberish"
  | "unsupported_numeric_claim"
  | "unresolved_template_token"
  | "excessive_repetition"
  | "sensitive_trait_revelation"
  | "sensitive_trait_implication"
  | "factual_contradiction";

export interface GeneratedEmailContent {
  subject?: string | null;
  preheader?: string | null;
  body?: string | null;
  offer?: string | null;
}

export interface SensitiveTraitMessageRule {
  id: string;
  revelationPhrases: readonly string[];
  implicationPhrases?: readonly string[];
}

export interface FactualContradictionRule {
  id: string;
  prohibitedPhrases: readonly string[];
}

export interface MessageQualityEvidence {
  supportedNumericClaims?: readonly string[];
  allowedTemplateTokens?: readonly string[];
  sensitiveTraitRules?: readonly SensitiveTraitMessageRule[];
  factualContradictions?: readonly FactualContradictionRule[];
}

export interface MessageQualityRequest {
  content: GeneratedEmailContent;
  evidence: MessageQualityEvidence;
}

export interface MessageQualityIssue {
  code: MessageQualityCode;
  severity: MessageQualitySeverity;
  field: MessageQualityField;
  message: string;
  reference?: string;
}

export interface MessageQualityResult {
  valid: boolean;
  blockingErrors: MessageQualityIssue[];
  warnings: MessageQualityIssue[];
}

export const SECOND_PASS_MESSAGE_REVIEW_BOUNDS = {
  maxContentCharacters: 120_000,
  maxEvidenceItems: 50,
  maxEvidenceCharacters: 12_000,
  maxFindings: 20,
} as const;

export type SecondPassReviewCriterion =
  | "usefulness"
  | "brand_voice"
  | "unsupported_claims"
  | "repetitive_language"
  | "awkward_personalization"
  | "sensitive_inference"
  | "factual_consistency";

export interface SecondPassMessageReviewRequest {
  schemaVersion: "1";
  bounds: typeof SECOND_PASS_MESSAGE_REVIEW_BOUNDS;
  content: GeneratedEmailContent;
  evidence: readonly {
    id: string;
    summary: string;
  }[];
  criteria: readonly SecondPassReviewCriterion[];
}

export interface SecondPassMessageReviewResponse {
  schemaVersion: "1";
  verdict: "pass" | "warn" | "block";
  findings: readonly {
    criterion: SecondPassReviewCriterion;
    severity: "warning" | "blocking";
    field?: MessageQualityField;
    explanation: string;
    evidenceIds: readonly string[];
  }[];
}

const FIELD_ORDER: readonly MessageQualityField[] = [
  "subject",
  "preheader",
  "body",
  "offer",
];

const UNRESOLVED_TEMPLATE_TOKEN_PATTERN =
  /\{\{[^{}]*\}\}|\{%[^%]*%\}|\[\[[^\[\]]+\]\]|<%[\s\S]*?%>|\$\{[^{}]+\}|\*\|[^|]+\|\*|%%[^%]+%%|\[[A-Z][A-Z0-9_. -]{2,}\]/gu;

const HARD_NUMERIC_CLAIM_PATTERN =
  /[$€£¥]\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\b(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:USD|EUR|GBP|CAD|AUD|NZD|KES)\b|\b\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\s*[x×](?![\p{L}\p{N}_])|\b(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s*[-–]\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)?\s+(?:customers?|orders?|people|items?|products?|days?|hours?|minutes?|weeks?|months?|years?|reviews?|ratings?|stars?|units?|times?|purchases?|subscribers?|members?|points?)\b/giu;

const INVALID_TEXT_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/u;
const REPEATED_CHARACTER_PATTERN = /([^\s])\1{6,}/iu;
const CONSONANT_RUN_PATTERN = /\b[bcdfghjklmnpqrstvwxyz]{13,}\b/iu;
const KEYBOARD_SMASH_PATTERN =
  /\b(?:qwertyui|asdfghjk|zxcvbnm|poiuytre|lkjhgfd|mnbvcxz)\w*\b/iu;

function visibleText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&(?:nbsp|amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function searchableText(value: string): string {
  return visibleText(value)
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}%$€£¥]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function wordTokens(value: string): string[] {
  return (
    visibleText(value)
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu) ?? []
  );
}

function normalizeNumericClaim(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/,/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/([$€£¥])\s+/gu, "$1")
    .replace(/\s+%/gu, "%")
    .trim();
}

function extractNumericClaims(value: string): string[] {
  return [...value.matchAll(HARD_NUMERIC_CLAIM_PATTERN)].map((match) =>
    normalizeNumericClaim(match[0]),
  );
}

function containsConfiguredPhrase(
  normalizedContent: string,
  configuredPhrase: string,
): boolean {
  const normalizedPhrase = searchableText(configuredPhrase);
  if (normalizedPhrase.length < 2) return false;
  return ` ${normalizedContent} `.includes(` ${normalizedPhrase} `);
}

function hasRepeatedPhrase(words: readonly string[]): boolean {
  for (let size = 1; size <= 4; size += 1) {
    for (let start = 0; start + size * 3 <= words.length; start += 1) {
      const phrase = words.slice(start, start + size).join("\0");
      if (
        words.slice(start + size, start + size * 2).join("\0") === phrase &&
        words.slice(start + size * 2, start + size * 3).join("\0") === phrase
      ) {
        return true;
      }
    }
  }
  return false;
}

function duplicateSentenceSeverity(
  value: string,
): MessageQualitySeverity | null {
  const counts = new Map<string, number>();
  let highestCount = 0;
  for (const sentence of visibleText(value).split(/[.!?]+/gu)) {
    const normalized = searchableText(sentence);
    if (normalized.length < 20) continue;
    const count = (counts.get(normalized) ?? 0) + 1;
    counts.set(normalized, count);
    highestCount = Math.max(highestCount, count);
  }
  if (highestCount >= 3) return "blocking";
  if (highestCount === 2) return "warning";
  return null;
}

function informationIssue(
  field: MessageQualityField,
  value: string,
): Pick<MessageQualityIssue, "severity" | "message"> | null {
  const words = wordTokens(value);
  const uniqueWords = new Set(words);

  if (field === "body" && (words.length < 5 || uniqueWords.size < 3)) {
    return {
      severity: "blocking",
      message:
        "The email body does not contain enough distinct language to be useful.",
    };
  }
  if (field === "subject" && words.length < 2) {
    return {
      severity: "warning",
      message: "The subject contains very little information.",
    };
  }
  if (field === "preheader" && words.length < 3) {
    return {
      severity: "warning",
      message: "The preheader contains very little information.",
    };
  }
  if (field === "offer" && words.length === 0) {
    return {
      severity: "warning",
      message: "The offer does not contain readable language.",
    };
  }
  return null;
}

function addIssue(
  blockingErrors: MessageQualityIssue[],
  warnings: MessageQualityIssue[],
  issue: MessageQualityIssue,
): void {
  const target = issue.severity === "blocking" ? blockingErrors : warnings;
  if (
    target.some(
      (existing) =>
        existing.code === issue.code &&
        existing.field === issue.field &&
        existing.reference === issue.reference,
    )
  ) {
    return;
  }
  target.push(issue);
}

export function validateMessageQuality(
  request: MessageQualityRequest,
): MessageQualityResult {
  const blockingErrors: MessageQualityIssue[] = [];
  const warnings: MessageQualityIssue[] = [];
  const allowedTemplateTokens = new Set(
    (request.evidence.allowedTemplateTokens ?? []).map((token) =>
      token.normalize("NFKC").trim(),
    ),
  );
  const supportedNumericClaims = new Set(
    (request.evidence.supportedNumericClaims ?? []).flatMap(
      extractNumericClaims,
    ),
  );

  for (const field of FIELD_ORDER) {
    const suppliedValue = request.content[field];
    const supplied = suppliedValue !== null && suppliedValue !== undefined;
    if (!supplied) {
      if (field === "subject" || field === "body") {
        addIssue(blockingErrors, warnings, {
          code: "empty_content",
          severity: "blocking",
          field,
          message: `${field === "subject" ? "Subject" : "Body"} is required.`,
        });
      }
      continue;
    }

    const value = suppliedValue;
    if (visibleText(value).length === 0) {
      addIssue(blockingErrors, warnings, {
        code: "empty_content",
        severity:
          field === "subject" || field === "body" ? "blocking" : "warning",
        field,
        message:
          field === "subject" || field === "body"
            ? `${field === "subject" ? "Subject" : "Body"} is required.`
            : `The ${field} is empty and should be omitted or completed.`,
      });
      continue;
    }

    const information = informationIssue(field, value);
    if (information) {
      addIssue(blockingErrors, warnings, {
        code: "low_information",
        field,
        ...information,
      });
    }

    const plainText = visibleText(value);
    if (
      INVALID_TEXT_PATTERN.test(value) ||
      REPEATED_CHARACTER_PATTERN.test(plainText) ||
      CONSONANT_RUN_PATTERN.test(plainText) ||
      KEYBOARD_SMASH_PATTERN.test(plainText)
    ) {
      addIssue(blockingErrors, warnings, {
        code: "gibberish",
        severity: "blocking",
        field,
        message:
          "The content contains corrupted or non-linguistic text patterns.",
      });
    }

    for (const match of value.matchAll(UNRESOLVED_TEMPLATE_TOKEN_PATTERN)) {
      const token = match[0].normalize("NFKC").trim();
      if (!allowedTemplateTokens.has(token)) {
        addIssue(blockingErrors, warnings, {
          code: "unresolved_template_token",
          severity: "blocking",
          field,
          message: "A template token remains unresolved.",
          reference: token,
        });
      }
    }

    for (const claim of new Set(extractNumericClaims(plainText))) {
      if (!supportedNumericClaims.has(claim)) {
        addIssue(blockingErrors, warnings, {
          code: "unsupported_numeric_claim",
          severity: "blocking",
          field,
          message:
            "A hard numeric claim is not supported by the supplied evidence.",
          reference: claim,
        });
      }
    }

    const words = wordTokens(plainText);
    if (hasRepeatedPhrase(words)) {
      addIssue(blockingErrors, warnings, {
        code: "excessive_repetition",
        severity: "blocking",
        field,
        message: "The content repeats the same language excessively.",
      });
    } else {
      const duplicateSeverity = duplicateSentenceSeverity(plainText);
      if (duplicateSeverity) {
        addIssue(blockingErrors, warnings, {
          code: "excessive_repetition",
          severity: duplicateSeverity,
          field,
          message:
            duplicateSeverity === "blocking"
              ? "The content repeats the same sentence excessively."
              : "The content repeats a full sentence.",
        });
      }
    }

    const normalizedContent = searchableText(plainText);
    for (const rule of request.evidence.sensitiveTraitRules ?? []) {
      if (
        rule.revelationPhrases.some((phrase) =>
          containsConfiguredPhrase(normalizedContent, phrase),
        )
      ) {
        addIssue(blockingErrors, warnings, {
          code: "sensitive_trait_revelation",
          severity: "blocking",
          field,
          message:
            "The content states a sensitive trait supplied by the safety context.",
          reference: rule.id,
        });
      }
      if (
        (rule.implicationPhrases ?? []).some((phrase) =>
          containsConfiguredPhrase(normalizedContent, phrase),
        )
      ) {
        addIssue(blockingErrors, warnings, {
          code: "sensitive_trait_implication",
          severity: "blocking",
          field,
          message:
            "The content strongly implies a sensitive trait supplied by the safety context.",
          reference: rule.id,
        });
      }
    }

    for (const rule of request.evidence.factualContradictions ?? []) {
      if (
        rule.prohibitedPhrases.some((phrase) =>
          containsConfiguredPhrase(normalizedContent, phrase),
        )
      ) {
        addIssue(blockingErrors, warnings, {
          code: "factual_contradiction",
          severity: "blocking",
          field,
          message:
            "The content contradicts a factual constraint supplied by the caller.",
          reference: rule.id,
        });
      }
    }
  }

  return {
    valid: blockingErrors.length === 0,
    blockingErrors,
    warnings,
  };
}
