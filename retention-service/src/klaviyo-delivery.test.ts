import { describe, expect, test } from "bun:test";

import {
  assertAllowedKlaviyoDeliveryPath,
  buildKlaviyoFinishedContentPayload,
} from "./klaviyo-delivery.js";

const valid = {
  recipientIdentifier: "buyer@example.com",
  opaqueDispatchId: "11111111-1111-4111-8111-111111111111",
  opaqueRecipientId: "22222222-2222-4222-8222-222222222222",
  subject: "A useful note",
  preheader: "A concise preheader",
  body: "<p>Hello</p>",
  offer: null,
};

describe("Klaviyo delivery containment", () => {
  test("emits only recipient, opaque ids, and finished content", () => {
    const payload = buildKlaviyoFinishedContentPayload(valid);
    expect(payload).toEqual({
      recipient: { email: "buyer@example.com" },
      dispatch_id: valid.opaqueDispatchId,
      recipient_id: valid.opaqueRecipientId,
      content: {
        subject: "A useful note",
        preheader: "A concise preheader",
        body: "<p>Hello</p>",
      },
    });
    expect(JSON.stringify(payload)).not.toContain("confidence");
    expect(JSON.stringify(payload)).not.toContain("segment");
  });

  test("rejects intelligence even when hidden in nested input", () => {
    expect(() =>
      buildKlaviyoFinishedContentPayload({
        ...valid,
        metadata: { confidence_score: 0.92 },
      }),
    ).toThrow("Worklin intelligence cannot be sent to Klaviyo");
  });

  test("blocks profile and segment APIs", () => {
    expect(() =>
      assertAllowedKlaviyoDeliveryPath("/api/segments"),
    ).toThrow();
    expect(() =>
      assertAllowedKlaviyoDeliveryPath("/api/profiles/123"),
    ).toThrow();
    expect(() =>
      assertAllowedKlaviyoDeliveryPath("/api/campaigns"),
    ).not.toThrow();
  });
});
