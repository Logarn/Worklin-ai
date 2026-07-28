import { describe, expect, test } from "bun:test";

import {
  assertCampaignCanCancel,
  operatorCustomerReference,
  operatorDecisionRationale,
  redactOperatorText,
} from "./operator-views.js";
import { RetentionServiceError } from "./types.js";

describe("retention operator view safety", () => {
  test("redacts known identifiers, emails, and phone numbers", () => {
    const value = redactOperatorText(
      "Alice at alice@example.com or +15550123 should receive the offer.",
      ["Alice"],
    );

    expect(value).toBe(
      "[redacted identifier] at [redacted email] or [redacted phone] should receive the offer.",
    );
    expect(value).not.toContain("alice@example.com");
    expect(value).not.toContain("+15550123");
  });

  test("uses stable tenant-specific pseudonymous customer references", () => {
    const customerId = "11111111-1111-4111-8111-111111111111";
    const first = operatorCustomerReference("org-a", customerId);
    expect(operatorCustomerReference("org-a", customerId)).toBe(first);
    expect(operatorCustomerReference("org-b", customerId)).not.toBe(first);
    expect(first).not.toContain(customerId);
  });

  test("withholds sensitive rationale even after human approval", () => {
    const result = operatorDecisionRationale({
      rationale:
        "The customer is likely to have a sensitive personal condition.",
      identifiers: [],
      sensitivity: "sensitive",
      approvedSensitiveUse: true,
    });

    expect(result.redacted).toBe(true);
    expect(result.summary).toContain("Human-approved");
    expect(result.summary).not.toContain("personal condition");
  });
});

describe("retention campaign cancellation safety", () => {
  const cancellable = {
    campaignStatus: "ready_to_send",
    dispatches: [
      {
        status: "pending",
        acceptedCount: 0,
        providerCampaignId: null,
        providerListId: null,
        providerPayloadReference: null,
      },
    ],
    acceptedRecipientCount: 0,
    runningDispatchJobCount: 0,
  };

  test("allows cancellation before provider acceptance", () => {
    expect(() => assertCampaignCanCancel(cancellable)).not.toThrow();
  });

  test("blocks cancellation after any provider-side acceptance marker", () => {
    const unsafeStates = [
      {
        ...cancellable,
        acceptedRecipientCount: 1,
      },
      {
        ...cancellable,
        dispatches: [
          {
            ...cancellable.dispatches[0]!,
            acceptedCount: 1,
          },
        ],
      },
      {
        ...cancellable,
        dispatches: [
          {
            ...cancellable.dispatches[0]!,
            providerCampaignId: "provider-campaign",
          },
        ],
      },
      {
        ...cancellable,
        campaignStatus: "sending",
      },
    ];

    for (const state of unsafeStates) {
      expect(() => assertCampaignCanCancel(state)).toThrow(
        RetentionServiceError,
      );
      try {
        assertCampaignCanCancel(state);
      } catch (error) {
        expect((error as RetentionServiceError).code).toBe(
          "campaign_cancellation_unsafe",
        );
      }
    }
  });

  test("blocks cancellation while a dispatch job is running", () => {
    expect(() =>
      assertCampaignCanCancel({
        ...cancellable,
        runningDispatchJobCount: 1,
      }),
    ).toThrow("delivery work is running");
  });
});
