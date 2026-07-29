import { z } from "zod";

import { RetentionServiceError } from "./types.js";

const forbiddenIntelligenceKey =
  /(?:^|_)(?:trait|confidence|evidence|segment|rationale|reasoning|hypothesis|dossier|decision|sensitivity|lawful_basis)(?:_|$)/iu;

const deliveryEnvelopeSchema = z
  .object({
    recipientIdentifier: z.string().email().max(320),
    opaqueDispatchId: z.string().uuid(),
    opaqueRecipientId: z.string().uuid(),
    subject: z.string().trim().min(1).max(1_000),
    preheader: z.string().trim().min(1).max(2_000).nullable(),
    body: z.string().trim().min(1).max(500_000),
    offer: z.string().trim().min(1).max(10_000).nullable(),
  })
  .strict();

export type KlaviyoDeliveryEnvelope = z.infer<typeof deliveryEnvelopeSchema>;

export interface KlaviyoFinishedContentPayload {
  recipient: { email: string };
  dispatch_id: string;
  recipient_id: string;
  content: {
    subject: string;
    preheader?: string;
    body: string;
    offer?: string;
  };
}

/**
 * Creates the only payload shape the future Klaviyo sender may receive.
 * It is intentionally independent of customer dossiers and decision records.
 */
export function buildKlaviyoFinishedContentPayload(
  value: unknown,
): KlaviyoFinishedContentPayload {
  assertNoIntelligenceKeys(value);
  const input = deliveryEnvelopeSchema.parse(value);
  return {
    recipient: { email: input.recipientIdentifier },
    dispatch_id: input.opaqueDispatchId,
    recipient_id: input.opaqueRecipientId,
    content: {
      subject: input.subject,
      ...(input.preheader ? { preheader: input.preheader } : {}),
      body: input.body,
      ...(input.offer ? { offer: input.offer } : {}),
    },
  };
}

export function assertNoIntelligenceKeys(
  value: unknown,
  path = "$",
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoIntelligenceKeys(item, `${path}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (forbiddenIntelligenceKey.test(key)) {
      throw new RetentionServiceError(
        "klaviyo_intelligence_egress_blocked",
        "Worklin intelligence cannot be sent to Klaviyo.",
        422,
        { field: `${path}.${key}` },
      );
    }
    assertNoIntelligenceKeys(nested, `${path}.${key}`);
  }
}

export const KLAVIYO_FORBIDDEN_RESOURCE_PATHS = [
  "/api/segments",
  "/api/profiles",
] as const;

export function assertAllowedKlaviyoDeliveryPath(path: string): void {
  if (
    KLAVIYO_FORBIDDEN_RESOURCE_PATHS.some(
      (blocked) => path === blocked || path.startsWith(`${blocked}/`),
    )
  ) {
    throw new RetentionServiceError(
      "klaviyo_resource_forbidden",
      "Worklin cannot write Klaviyo profiles or segments.",
      403,
    );
  }
  if (
    !path.startsWith("/api/campaigns") &&
    !path.startsWith("/api/lists") &&
    !path.startsWith("/api/recipient-bulk")
  ) {
    throw new RetentionServiceError(
      "klaviyo_resource_not_allowed",
      "That Klaviyo delivery resource is not allowlisted.",
      403,
    );
  }
}
