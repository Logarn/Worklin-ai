import { describe, expect, test } from "bun:test";

import {
  campaignEligibility,
  evaluateSegmentExpression,
  validateSafeSegmentExpression,
  type SegmentCustomerState,
} from "./segment-runs.js";

const state: SegmentCustomerState = {
  profile: {
    status: "active",
    has_email: true,
    has_phone: false,
    created_at: "2026-01-01T00:00:00.000Z",
    source_updated_at: "2026-07-30T00:00:00.000Z",
  },
  consent: { email: "subscribed" },
  metric: {
    source_event_count: 12,
    klaviyo_event_count: 10,
    days_since_last_event: 5,
  },
  evidence: {
    provider: ["klaviyo"],
    event_type: ["klaviyo.event", "klaviyo.profile.snapshot"],
  },
  trait: {
    "klaviyo.Customer stage": "Considering",
  },
};

describe("segment run expression boundary", () => {
  test("evaluates nested expressions deterministically", () => {
    const expression = {
      type: "all" as const,
      expressions: [
        {
          type: "predicate" as const,
          namespace: "metric" as const,
          key: "source_event_count",
          operator: "greater_than_or_equal" as const,
          value: 10,
        },
        {
          type: "any" as const,
          expressions: [
            {
              type: "predicate" as const,
              namespace: "evidence" as const,
              key: "provider",
              operator: "contains" as const,
              value: "klaviyo",
            },
            {
              type: "predicate" as const,
              namespace: "profile" as const,
              key: "has_phone",
              operator: "equals" as const,
              value: true,
            },
          ],
        },
        {
          type: "predicate" as const,
          namespace: "trait" as const,
          key: "klaviyo.Customer stage",
          operator: "equals" as const,
          value: "Considering",
        },
      ],
    };

    expect(validateSafeSegmentExpression(expression)).toEqual({ ok: true });
    expect(evaluateSegmentExpression(expression, state)).toBe(true);
    expect(
      evaluateSegmentExpression(
        {
          type: "predicate",
          namespace: "metric",
          key: "days_since_last_event",
          operator: "greater_than",
          value: 30,
        },
        state,
      ),
    ).toBe(false);
  });

  test("rejects unbounded profile and non-Klaviyo trait references", () => {
    expect(
      validateSafeSegmentExpression({
        type: "predicate",
        namespace: "profile",
        key: "email",
        operator: "exists",
      }),
    ).toMatchObject({ ok: false, code: "unsafe_segment_reference" });
    expect(
      validateSafeSegmentExpression({
        type: "predicate",
        namespace: "trait",
        key: "private.email",
        operator: "exists",
      }),
    ).toMatchObject({ ok: false, code: "unsafe_segment_reference" });
    expect(
      validateSafeSegmentExpression({
        type: "predicate",
        namespace: "metric",
        key: "source_event_count",
        operator: "greater_than",
        value: "ten" as unknown as number,
      }),
    ).toMatchObject({ ok: false, code: "invalid_segment_expression" });
    expect(
      validateSafeSegmentExpression({
        type: "unknown",
      } as unknown as Parameters<typeof validateSafeSegmentExpression>[0]),
    ).toMatchObject({ ok: false, code: "invalid_segment_expression" });
  });

  test("keeps membership separate from campaign eligibility", () => {
    expect(campaignEligibility(state)).toEqual({
      eligible: true,
      reason: "eligible",
    });
    expect(
      campaignEligibility({
        ...state,
        consent: { email: "suppressed" },
      }),
    ).toEqual({ eligible: false, reason: "suppressed" });
    expect(
      campaignEligibility({
        ...state,
        profile: { ...state.profile, has_email: false },
      }),
    ).toEqual({ eligible: false, reason: "missing_email" });
  });
});
