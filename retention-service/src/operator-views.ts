import { createHash } from "node:crypto";

import { RetentionServiceError } from "./types.js";

const EMAIL_PATTERN =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE_PATTERN = /(?<!\w)\+?[1-9]\d{7,14}(?!\w)/gu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function redactOperatorText(
  value: string,
  identifiers: readonly string[],
): string {
  let redacted = value
    .replace(EMAIL_PATTERN, "[redacted email]")
    .replace(PHONE_PATTERN, "[redacted phone]");
  for (const identifier of [...identifiers]
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .sort((left, right) => right.length - left.length)) {
    redacted = redacted.replace(
      new RegExp(escapeRegExp(identifier), "giu"),
      "[redacted identifier]",
    );
  }
  return redacted;
}

export function operatorCustomerReference(
  organizationId: string,
  customerId: string,
): string {
  return `customer_${createHash("sha256")
    .update(organizationId)
    .update("\0")
    .update(customerId)
    .digest("hex")
    .slice(0, 12)}`;
}

export function operatorDecisionRationale(input: {
  rationale: string;
  identifiers: readonly string[];
  sensitivity: string;
  approvedSensitiveUse: boolean;
}): {
  summary: string;
  redacted: boolean;
} {
  if (
    input.sensitivity === "sensitive" ||
    input.sensitivity === "restricted"
  ) {
    return {
      summary: input.approvedSensitiveUse
        ? "Human-approved sensitive evidence contributed to this decision. The underlying trait and evidence are withheld."
        : "Sensitive evidence may have contributed to this decision. Details are withheld until targeting is explicitly approved.",
      redacted: true,
    };
  }
  return {
    summary: redactOperatorText(input.rationale, input.identifiers),
    redacted: false,
  };
}

export interface CampaignCancellationState {
  campaignStatus: string;
  dispatches: Array<{
    status: string;
    acceptedCount: number;
    providerCampaignId: string | null;
    providerListId: string | null;
    providerPayloadReference: string | null;
  }>;
  acceptedRecipientCount: number;
  runningDispatchJobCount: number;
}

export function assertCampaignCanCancel(
  state: CampaignCancellationState,
): void {
  if (state.campaignStatus === "cancelled") return;
  if (
    state.campaignStatus === "sending" ||
    state.campaignStatus === "sent" ||
    state.campaignStatus === "partially_sent" ||
    state.dispatches.some(
      (dispatch) =>
        dispatch.status === "sending" ||
        dispatch.status === "sent" ||
        dispatch.status === "partially_sent" ||
        dispatch.acceptedCount > 0 ||
        dispatch.providerCampaignId !== null ||
        dispatch.providerListId !== null ||
        dispatch.providerPayloadReference !== null,
    ) ||
    state.acceptedRecipientCount > 0
  ) {
    throw new RetentionServiceError(
      "campaign_cancellation_unsafe",
      "The campaign cannot be cancelled because Klaviyo may already have accepted delivery work.",
      409,
    );
  }
  if (state.runningDispatchJobCount > 0) {
    throw new RetentionServiceError(
      "campaign_cancellation_in_progress",
      "The campaign cannot be cancelled while delivery work is running.",
      409,
    );
  }
}
