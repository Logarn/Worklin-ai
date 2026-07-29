import { describe, expect, test } from "bun:test";

import {
  SECOND_PASS_MESSAGE_REVIEW_BOUNDS,
  validateMessageQuality,
  type SecondPassMessageReviewRequest,
} from "./message-quality.js";

const usefulMarketerCopy = {
  subject: "A fresh routine for your next reset",
  preheader: "Thoughtful essentials selected for an easier week.",
  body: `
    <p>Hi there,</p>
    <p>Your recent browsing suggests our everyday collection may be useful.
    Explore the edit when the timing feels right, or reply if you would like
    help choosing.</p>
  `,
  offer: "Complimentary product guidance from our team",
};

describe("message quality validation", () => {
  test("accepts useful normal marketer copy", () => {
    const result = validateMessageQuality({
      content: usefulMarketerCopy,
      evidence: {},
    });

    expect(result).toEqual({
      valid: true,
      blockingErrors: [],
      warnings: [],
    });
  });

  test("accepts supported numeric claims and ignores digits in offer codes", () => {
    const result = validateMessageQuality({
      content: {
        subject: "Enjoy 20% off your next order",
        preheader: "Use code WELCOME20 when you are ready.",
        body: "Take 20% off the collection selected for you. Use code WELCOME20 before checkout.",
        offer: "20% off with code WELCOME20",
      },
      evidence: {
        supportedNumericClaims: ["The approved offer is a 20% discount."],
      },
    });

    expect(result.valid).toBe(true);
    expect(result.blockingErrors).toEqual([]);
  });

  test("blocks missing required fields and warns about empty optional fields", () => {
    const result = validateMessageQuality({
      content: {
        subject: "   ",
        preheader: "",
        body: null,
      },
      evidence: {},
    });

    expect(result.valid).toBe(false);
    expect(
      result.blockingErrors.map(({ code, field }) => ({ code, field })),
    ).toEqual([
      { code: "empty_content", field: "subject" },
      { code: "empty_content", field: "body" },
    ]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "empty_content",
        field: "preheader",
      }),
    ]);
  });

  test("blocks a low-information body and warns on thin subject copy", () => {
    const result = validateMessageQuality({
      content: {
        subject: "Welcome",
        body: "Buy now.",
      },
      evidence: {},
    });

    expect(result.valid).toBe(false);
    expect(result.blockingErrors).toContainEqual(
      expect.objectContaining({
        code: "low_information",
        field: "body",
      }),
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "low_information",
        field: "subject",
      }),
    );
  });

  test("blocks corrupted and non-linguistic text patterns", () => {
    const result = validateMessageQuality({
      content: {
        subject: "An update for you",
        body: "Here is your collection update xqzvbnmklpqrst with useful details.\uFFFD",
      },
      evidence: {},
    });

    expect(result.blockingErrors).toContainEqual(
      expect.objectContaining({
        code: "gibberish",
        field: "body",
      }),
    );
  });

  test("blocks unresolved tokens but permits explicitly allowed dynamic tokens", () => {
    const blocked = validateMessageQuality({
      content: {
        subject: "A note for {{ first_name }}",
        body: "Hello *|FNAME|*, your selected collection is ready to explore today.",
      },
      evidence: {},
    });
    expect(
      blocked.blockingErrors.filter(
        ({ code }) => code === "unresolved_template_token",
      ),
    ).toHaveLength(2);

    const allowed = validateMessageQuality({
      content: {
        subject: "A note for {{ first_name }}",
        body: "Hello *|FNAME|*, your selected collection is ready to explore today.",
      },
      evidence: {
        allowedTemplateTokens: ["{{ first_name }}", "*|FNAME|*"],
      },
    });
    expect(allowed.valid).toBe(true);
  });

  test("blocks every unsupported hard numeric claim", () => {
    const result = validateMessageQuality({
      content: {
        subject: "Join 5,000 customers who made the switch",
        preheader: "See results in 3 days.",
        body: "Customers report 40% better results in 3 days after making the switch.",
        offer: "$25 off your next order",
      },
      evidence: {
        supportedNumericClaims: ["The approved offer is $25 off."],
      },
    });

    expect(
      result.blockingErrors
        .filter(({ code }) => code === "unsupported_numeric_claim")
        .map(({ reference }) => reference),
    ).toEqual(["5000 customers", "3 days", "40%", "3 days"]);
    expect(
      result.blockingErrors.some(({ reference }) => reference === "$25"),
    ).toBe(false);
  });

  test("blocks repeated phrases and warns when a full sentence is duplicated", () => {
    const blocked = validateMessageQuality({
      content: {
        subject: "A useful update",
        body: "Shop now shop now shop now for a thoughtful addition to your routine.",
      },
      evidence: {},
    });
    expect(blocked.blockingErrors).toContainEqual(
      expect.objectContaining({
        code: "excessive_repetition",
        field: "body",
      }),
    );

    const warned = validateMessageQuality({
      content: {
        subject: "A useful update",
        body: "Explore the collection selected for your next routine. Explore the collection selected for your next routine. We are here if you need help choosing.",
      },
      evidence: {},
    });
    expect(warned.valid).toBe(true);
    expect(warned.warnings).toContainEqual(
      expect.objectContaining({
        code: "excessive_repetition",
        field: "body",
      }),
    );
  });

  test("blocks supplied sensitive-trait revelation and implication phrases", () => {
    const result = validateMessageQuality({
      content: {
        subject: "Support for your pregnancy",
        body: "Because you are pregnant, these products for your new baby may be useful.",
      },
      evidence: {
        sensitiveTraitRules: [
          {
            id: "health-status",
            revelationPhrases: ["your pregnancy", "because you are pregnant"],
            implicationPhrases: ["products for your new baby"],
          },
        ],
      },
    });

    expect(result.blockingErrors).toContainEqual(
      expect.objectContaining({
        code: "sensitive_trait_revelation",
        field: "subject",
        reference: "health-status",
      }),
    );
    expect(result.blockingErrors).toContainEqual(
      expect.objectContaining({
        code: "sensitive_trait_implication",
        field: "body",
        reference: "health-status",
      }),
    );
  });

  test("blocks factual contradictions supplied by the caller", () => {
    const result = validateMessageQuality({
      content: {
        subject: "Free shipping on your order",
        body: "Your order includes free shipping, and our support team can help with product questions.",
      },
      evidence: {
        factualContradictions: [
          {
            id: "shipping-policy",
            prohibitedPhrases: ["free shipping", "shipping is complimentary"],
          },
        ],
      },
    });

    expect(result.blockingErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "factual_contradiction",
          field: "subject",
          reference: "shipping-policy",
        }),
        expect.objectContaining({
          code: "factual_contradiction",
          field: "body",
          reference: "shipping-policy",
        }),
      ]),
    );
  });

  test("does not expose sensitive configured phrases in issue messages", () => {
    const privatePhrase = "private sensitive condition";
    const result = validateMessageQuality({
      content: {
        subject: "A private sensitive condition update",
        body: "This message mentions a private sensitive condition and includes enough supporting words.",
      },
      evidence: {
        sensitiveTraitRules: [
          {
            id: "restricted-trait",
            revelationPhrases: [privatePhrase],
          },
        ],
      },
    });

    expect(JSON.stringify(result)).not.toContain(privatePhrase);
    expect(JSON.stringify(result)).toContain("restricted-trait");
  });
});

describe("bounded second-pass review contract", () => {
  test("carries explicit input and output bounds without invoking a model", () => {
    const request: SecondPassMessageReviewRequest = {
      schemaVersion: "1",
      bounds: SECOND_PASS_MESSAGE_REVIEW_BOUNDS,
      content: usefulMarketerCopy,
      evidence: [
        {
          id: "brand-direction",
          summary: "Keep the tone warm, practical, and unhurried.",
        },
      ],
      criteria: ["usefulness", "brand_voice", "factual_consistency"],
    };

    expect(request.bounds).toEqual({
      maxContentCharacters: 120_000,
      maxEvidenceItems: 50,
      maxEvidenceCharacters: 12_000,
      maxFindings: 20,
    });
  });
});
