import { z } from "zod";

import type { NormalizedSourcePayload } from "./types.js";

const customerSchema = z
  .object({
    externalId: z.string().trim().min(1).max(512).optional(),
    email: z.string().trim().email().max(512).optional(),
    phone: z.string().trim().min(3).max(64).optional(),
    displayName: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

const consentSchema = z
  .object({
    channel: z.enum(["email", "sms", "push", "whatsapp"]),
    state: z.enum(["subscribed", "unsubscribed", "suppressed", "unknown"]),
  })
  .strict();

const traitSchema = z
  .object({
    key: z.string().trim().min(1).max(512),
    value: z.unknown(),
    evidenceKind: z.enum(["observed", "declared", "imported"]),
    sensitivity: z.enum(["standard", "personal", "sensitive", "restricted"]),
    confidence: z.number().min(0).max(1),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

const normalizedSourcePayloadSchema = z
  .object({
    customer: customerSchema.optional(),
    consent: consentSchema.optional(),
    traits: z.array(traitSchema).max(2_000).optional(),
    commerce: z.record(z.string(), z.unknown()).optional(),
    delivery: z.record(z.string(), z.unknown()).optional(),
    source: z.record(z.string(), z.unknown()),
  })
  .strict();

export function parseNormalizedSourcePayload(
  value: unknown,
): NormalizedSourcePayload {
  return normalizedSourcePayloadSchema.parse(value);
}

export function normalizeEmail(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function normalizePhone(value: string): string {
  return value.replace(/[^\d+]/gu, "");
}
