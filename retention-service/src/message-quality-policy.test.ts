import { describe, expect, test } from "bun:test";

import { validateMessageQuality } from "./message-quality.js";
import { buildMessageQualityEvidence } from "./message-quality-policy.js";

describe("message quality evidence policy", () => {
  test("supports only numeric claims present in frozen strategy or offer", () => {
    const evidence = buildMessageQualityEvidence({
      frozenStrategy: {
        objective: "Win back recent non-buyers",
        proof: ["Used by 2,500 customers"],
      },
      approvedOffer: { summary: "20% off the next order" },
    });

    const valid = validateMessageQuality({
      content: {
        subject: "Enjoy 20% off your next order",
        body: "Join 2,500 customers and explore the collection with 20% off today.",
      },
      evidence,
    });
    const invalid = validateMessageQuality({
      content: {
        subject: "Enjoy 40% off your next order",
        body: "Join 9,000 customers and explore the collection with 40% off today.",
      },
      evidence,
    });

    expect(valid.valid).toBe(true);
    expect(invalid.blockingErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unsupported_numeric_claim",
          reference: "40%",
        }),
        expect.objectContaining({
          code: "unsupported_numeric_claim",
          reference: "9000 customers",
        }),
      ]),
    );
  });

  test("derives revelation phrases from sensitive trait evidence", () => {
    const evidence = buildMessageQualityEvidence({
      frozenStrategy: {},
      sensitiveTraits: [
        {
          id: "trait-1",
          key: "pregnancy_status",
          value: { label: "pregnant" },
          implicationPhrases: ["products for your new baby"],
        },
      ],
    });
    const result = validateMessageQuality({
      content: {
        subject: "Support during your pregnancy status",
        body: "Because you are pregnant, these products for your new baby may help.",
      },
      evidence,
    });

    expect(result.valid).toBe(false);
    expect(result.blockingErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "sensitive_trait_revelation",
          reference: "trait-1",
        }),
        expect.objectContaining({
          code: "sensitive_trait_implication",
          reference: "trait-1",
        }),
      ]),
    );
  });

  test("does not turn generic trait metadata into revelation phrases", () => {
    const evidence = buildMessageQualityEvidence({
      frozenStrategy: {},
      sensitiveTraits: [
        {
          id: "trait-2",
          key: "status",
          value: { source: "inferred", approved: true },
        },
      ],
    });

    expect(evidence.sensitiveTraitRules).toEqual([
      {
        id: "trait-2",
        revelationPhrases: ["status"],
        implicationPhrases: [],
      },
    ]);
  });

  test("bounds and deduplicates nested evidence", () => {
    const evidence = buildMessageQualityEvidence({
      frozenStrategy: {
        first: "Save $25 today",
        nested: { duplicate: "Save $25 today" },
      },
      approvedOffer: ["Save $25 today"],
      allowedTemplateTokens: ["{{ first_name }}", "{{ first_name }}"],
    });

    expect(evidence.supportedNumericClaims).toEqual(["Save $25 today"]);
    expect(evidence.allowedTemplateTokens).toEqual(["{{ first_name }}"]);
  });
});
