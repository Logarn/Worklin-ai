import type {
  FactualContradictionRule,
  MessageQualityEvidence,
  SensitiveTraitMessageRule,
} from "./message-quality.js";

const MAX_EVIDENCE_STRINGS = 250;
const MAX_EVIDENCE_DEPTH = 8;
const MAX_EVIDENCE_STRING_LENGTH = 2_000;

const NON_REVEALING_TRAIT_VALUES = new Set([
  "approved",
  "declared",
  "false",
  "imported",
  "inferred",
  "observed",
  "personal",
  "restricted",
  "sensitive",
  "standard",
  "true",
  "unknown",
]);

export interface MessageQualitySensitiveTrait {
  id: string;
  key: string;
  value: unknown;
  implicationPhrases?: readonly string[];
}

export interface BuildMessageQualityEvidenceInput {
  frozenStrategy: unknown;
  approvedOffer?: unknown;
  allowedTemplateTokens?: readonly string[];
  sensitiveTraits?: readonly MessageQualitySensitiveTrait[];
  factualContradictions?: readonly FactualContradictionRule[];
}

function collectEvidenceStrings(value: unknown): string[] {
  const output: string[] = [];
  const seen = new Set<object>();

  const visit = (candidate: unknown, depth: number): void => {
    if (
      output.length >= MAX_EVIDENCE_STRINGS ||
      depth > MAX_EVIDENCE_DEPTH ||
      candidate === null ||
      candidate === undefined
    ) {
      return;
    }
    if (typeof candidate === "string") {
      const normalized = candidate.normalize("NFKC").trim();
      if (normalized && normalized.length <= MAX_EVIDENCE_STRING_LENGTH) {
        output.push(normalized);
      }
      return;
    }
    if (typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry, depth + 1);
      return;
    }
    for (const entry of Object.values(candidate)) visit(entry, depth + 1);
  };

  visit(value, 0);
  return [...new Set(output)];
}

function normalizedPhrase(value: string): string | null {
  const phrase = value
    .normalize("NFKC")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (
    phrase.length < 3 ||
    NON_REVEALING_TRAIT_VALUES.has(phrase.toLocaleLowerCase("en-US"))
  ) {
    return null;
  }
  return phrase;
}

function sensitiveTraitRule(
  trait: MessageQualitySensitiveTrait,
): SensitiveTraitMessageRule | null {
  const revelationPhrases = [
    normalizedPhrase(trait.key),
    ...collectEvidenceStrings(trait.value).map(normalizedPhrase),
  ].filter((value): value is string => value !== null);
  const implicationPhrases = (trait.implicationPhrases ?? [])
    .map(normalizedPhrase)
    .filter((value): value is string => value !== null);

  if (revelationPhrases.length === 0 && implicationPhrases.length === 0) {
    return null;
  }
  return {
    id: trait.id,
    revelationPhrases: [...new Set(revelationPhrases)],
    implicationPhrases: [...new Set(implicationPhrases)],
  };
}

export function buildMessageQualityEvidence(
  input: BuildMessageQualityEvidenceInput,
): MessageQualityEvidence {
  const sensitiveTraitRules = (input.sensitiveTraits ?? [])
    .map(sensitiveTraitRule)
    .filter((rule): rule is SensitiveTraitMessageRule => rule !== null);

  return {
    supportedNumericClaims: [
      ...new Set([
        ...collectEvidenceStrings(input.frozenStrategy),
        ...collectEvidenceStrings(input.approvedOffer),
      ]),
    ],
    allowedTemplateTokens: [...new Set(input.allowedTemplateTokens ?? [])],
    sensitiveTraitRules,
    factualContradictions: [...(input.factualContradictions ?? [])],
  };
}
