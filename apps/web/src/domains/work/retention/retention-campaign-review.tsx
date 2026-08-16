import {
  AlertCircle,
  Check,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  FileCheck2,
  Loader2,
  LockKeyhole,
  MailCheck,
  RefreshCw,
  Send,
  ShieldAlert,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAuthStore } from "@/stores/auth-store";
import { Button, ConfirmDialog } from "@vellumai/design-library";

import type {
  RetentionCampaignApprovalPreview,
  RetentionCampaignPreview,
  RetentionCampaignStatus,
  RetentionCampaignSummary,
  RetentionStatus,
} from "./retention-api";
import { RetentionApiError } from "./retention-api";
import {
  useApproveRetentionCampaign,
  useReleaseRetentionCampaign,
  useRetentionCampaignReview,
  useRetentionCampaigns,
} from "./use-retention-campaigns";

const CAMPAIGN_STATUS: Record<
  RetentionCampaignStatus,
  { label: string; className: string }
> = {
  draft: {
    label: "Draft",
    className: "text-[var(--content-secondary)]",
  },
  audience_frozen: {
    label: "Audience frozen",
    className: "text-[var(--content-secondary)]",
  },
  generating: {
    label: "Generating",
    className: "text-[var(--content-secondary)]",
  },
  review_required: {
    label: "Needs approval",
    className: "text-[var(--system-warning-strong)]",
  },
  approved: {
    label: "Approved",
    className: "text-[var(--content-success)]",
  },
  ready_to_send: {
    label: "Queued for Klaviyo",
    className: "text-[var(--content-secondary)]",
  },
  sending: {
    label: "Sending",
    className: "text-[var(--content-secondary)]",
  },
  sent: {
    label: "Sent",
    className: "text-[var(--content-success)]",
  },
  partially_sent: {
    label: "Partially sent",
    className: "text-[var(--system-warning-strong)]",
  },
  failed: {
    label: "Failed",
    className: "text-[var(--system-negative-strong)]",
  },
  cancelled: {
    label: "Cancelled",
    className: "text-[var(--content-tertiary)]",
  },
};

const TERMINAL_OR_RELEASED_STATUSES: RetentionCampaignStatus[] = [
  "ready_to_send",
  "sending",
  "sent",
  "partially_sent",
  "failed",
  "cancelled",
];

function formatProgram(value: string): string {
  return value
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatCampaignMode(value: RetentionCampaignSummary["mode"]): string {
  return value === "individual_message"
    ? "Individual messages"
    : "Dynamic template";
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 1 ? 2 : 0,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function isCampaignReviewStale(
  preview: RetentionCampaignPreview,
  approvalPreview: RetentionCampaignApprovalPreview,
): boolean {
  return (
    !preview.audience ||
    preview.campaign.id !== approvalPreview.campaignId ||
    preview.campaign.revision !== approvalPreview.campaignRevision ||
    preview.campaign.mode !== approvalPreview.mode ||
    preview.audience.id !== approvalPreview.audienceSnapshotId ||
    preview.audience.snapshotSha256 !== approvalPreview.audienceChecksum
  );
}

function campaignErrorMessage(
  error: unknown,
  action: "list" | "review" | "approve" | "send",
): string {
  if (error instanceof RetentionApiError) {
    if (error.code === "approval_invalidated" || error.status === 409) {
      return action === "send"
        ? "This approval is no longer current. Review and approve the campaign again before sending."
        : "The campaign changed while it was open. Refresh it before continuing.";
    }
    if (error.status === 403) {
      if (action === "approve") {
        return "Your account is not assigned as a named campaign approver.";
      }
      if (action === "send") {
        return "Your account is not assigned as a campaign sender, or sending is disabled.";
      }
      return "You do not have access to retention campaigns in this workspace.";
    }
    if (error.status === 404) {
      return "This campaign is no longer available in this workspace.";
    }
    if (error.status === 503) {
      return action === "send"
        ? "Sending through Klaviyo is currently disabled."
        : "Retention campaign review is not ready for this workspace yet.";
    }
  }

  if (action === "approve") {
    return "Worklin could not approve this campaign. Nothing was sent.";
  }
  if (action === "send") {
    return "Worklin could not start the Klaviyo send. Review delivery status before trying again.";
  }
  return action === "list"
    ? "Worklin could not load campaigns right now."
    : "Worklin could not load this campaign review right now.";
}

function CampaignListItem({
  campaign,
  selected,
  onSelect,
}: {
  campaign: RetentionCampaignSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const status = CAMPAIGN_STATUS[campaign.status];

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={`group w-full border-b border-[var(--border-base)] px-4 py-4 text-left transition-colors last:border-b-0 hover:bg-[var(--surface-hover)] ${
        selected ? "bg-[var(--surface-lift)]" : "bg-[var(--surface-base)]"
      }`}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block truncate text-body-medium-default text-[var(--content-emphasised)]">
            {campaign.name}
          </span>
          <span className="mt-1 block text-body-small-default text-[var(--content-tertiary)]">
            {campaign.programName}
          </span>
        </span>
        <ChevronRight
          className={`mt-0.5 size-4 shrink-0 ${
            selected
              ? "text-[var(--content-default)]"
              : "text-[var(--content-tertiary)]"
          }`}
          aria-hidden="true"
        />
      </span>
      <span className="mt-3 flex items-center justify-between gap-3 text-body-small-default">
        <span className={status.className}>{status.label}</span>
        <span className="text-[var(--content-tertiary)]">
          {campaign.audienceMemberCount.toLocaleString()} recipients
        </span>
      </span>
    </button>
  );
}

function CampaignListState({
  campaigns,
  selectedCampaignId,
  onSelect,
}: {
  campaigns: RetentionCampaignSummary[];
  selectedCampaignId: string | null;
  onSelect: (campaignId: string) => void;
}) {
  if (campaigns.length === 0) {
    return (
      <div className="px-5 py-10 text-center">
        <FileCheck2 className="mx-auto size-6 text-[var(--content-tertiary)]" />
        <p className="mt-3 text-body-medium-default text-[var(--content-default)]">
          No campaigns to review
        </p>
        <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
          Generated retention campaigns will appear here.
        </p>
      </div>
    );
  }

  return (
    <div>
      {campaigns.map((campaign) => (
        <CampaignListItem
          key={campaign.id}
          campaign={campaign}
          selected={campaign.id === selectedCampaignId}
          onSelect={() => onSelect(campaign.id)}
        />
      ))}
    </div>
  );
}

function ReviewFacts({
  campaign,
  preview,
  approvalPreview,
}: {
  campaign: RetentionCampaignSummary;
  preview: RetentionCampaignPreview;
  approvalPreview: RetentionCampaignApprovalPreview | undefined;
}) {
  const facts = [
    {
      label: "Audience",
      value: preview.audience
        ? preview.audience.memberCount.toLocaleString()
        : "Not frozen",
      icon: Users,
    },
    {
      label: "Messages ready",
      value: (approvalPreview?.contentCount ?? campaign.renderedMessageCount)
        .toLocaleString(),
      icon: MailCheck,
    },
    {
      label: "Sensitive review",
      value: (preview.audience?.sensitiveMemberCount ?? 0).toLocaleString(),
      icon: ShieldAlert,
    },
    {
      label: "Estimated AI cost",
      value: formatUsd(campaign.estimatedCostUsd),
      icon: CircleDollarSign,
    },
  ];

  return (
    <dl className="grid grid-cols-2 border-y border-[var(--border-base)] md:grid-cols-4">
      {facts.map(({ label, value, icon: Icon }) => (
        <div
          key={label}
          className="min-w-0 border-b border-[var(--border-base)] px-4 py-4 last:border-b-0 even:border-l md:border-b-0 md:border-l md:first:border-l-0"
        >
          <dt className="flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)]">
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            {label}
          </dt>
          <dd className="mt-2 text-title-small tabular-nums text-[var(--content-emphasised)]">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function QualitySummary({
  preview,
}: {
  preview: RetentionCampaignPreview;
}) {
  const qualityCounts = preview.messageSamples.reduce(
    (counts, sample) => {
      counts[sample.qualityStatus] += 1;
      if (sample.contentWithheld) counts.withheld += 1;
      return counts;
    },
    { passed: 0, needs_review: 0, blocked: 0, withheld: 0 },
  );

  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2 text-body-small-default">
      <span className="flex items-center gap-2 text-[var(--content-secondary)]">
        <Check
          className="size-4 text-[var(--content-success)]"
          aria-hidden="true"
        />
        {qualityCounts.passed} passed
      </span>
      <span className="flex items-center gap-2 text-[var(--content-secondary)]">
        <AlertCircle
          className="size-4 text-[var(--system-warning-strong)]"
          aria-hidden="true"
        />
        {qualityCounts.needs_review} need review
      </span>
      <span className="flex items-center gap-2 text-[var(--content-secondary)]">
        <ShieldAlert
          className="size-4 text-[var(--system-negative-strong)]"
          aria-hidden="true"
        />
        {qualityCounts.blocked} blocked
      </span>
      <span className="flex items-center gap-2 text-[var(--content-secondary)]">
        <LockKeyhole className="size-4" aria-hidden="true" />
        {qualityCounts.withheld} sensitive samples withheld
      </span>
    </div>
  );
}

function RepresentativeSamples({
  preview,
}: {
  preview: RetentionCampaignPreview;
}) {
  return (
    <section aria-labelledby="sample-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3
            id="sample-heading"
            className="text-title-small text-[var(--content-emphasised)]"
          >
            Representative messages
          </h3>
          <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
            Personal identifiers and sensitive evidence are not shown.
          </p>
        </div>
        <QualitySummary preview={preview} />
      </div>

      {preview.messageSamples.length === 0 ? (
        <div className="mt-4 border-y border-[var(--border-base)] py-8 text-center">
          <p className="text-body-small-default text-[var(--content-tertiary)]">
            No generated message samples are ready yet.
          </p>
        </div>
      ) : (
        <div className="mt-4 grid gap-3 xl:grid-cols-2">
          {preview.messageSamples.map((sample, index) => (
            <article
              key={`${index}-${sample.subject ?? "withheld"}`}
              className="min-w-0 rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-label-small text-[var(--content-tertiary)]">
                  SAMPLE {String(index + 1).padStart(2, "0")}
                </span>
                <span
                  className={`text-body-small-default ${
                    sample.qualityStatus === "passed"
                      ? "text-[var(--content-success)]"
                      : sample.qualityStatus === "blocked"
                        ? "text-[var(--system-negative-strong)]"
                        : "text-[var(--system-warning-strong)]"
                  }`}
                >
                  {sample.qualityStatus === "passed"
                    ? "Passed"
                    : sample.qualityStatus === "blocked"
                      ? "Blocked"
                      : "Needs review"}
                </span>
              </div>

              {sample.contentWithheld ? (
                <div className="mt-5 flex items-start gap-3 rounded-md bg-[var(--surface-lift)] p-4">
                  <LockKeyhole
                    className="mt-0.5 size-4 shrink-0 text-[var(--content-secondary)]"
                    aria-hidden="true"
                  />
                  <div>
                    <p className="text-body-medium-default text-[var(--content-default)]">
                      Sensitive content withheld
                    </p>
                    <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
                      A named approver must review this recipient through the
                      restricted workflow.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="mt-4">
                  <p className="text-body-medium-default text-[var(--content-emphasised)]">
                    {sample.subject ?? "No subject"}
                  </p>
                  {sample.preheader ? (
                    <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
                      {sample.preheader}
                    </p>
                  ) : null}
                  <div className="mt-4 max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-[var(--border-base)] pt-4 text-body-small-default text-[var(--content-secondary)]">
                    {sample.body ?? "Message body unavailable."}
                    {sample.bodyTruncated ? (
                      <span className="mt-3 block text-[var(--content-tertiary)]">
                        Preview shortened
                      </span>
                    ) : null}
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function useApproverDisplayName(): string {
  const user = useAuthStore.use.user();
  if (!user) return "signed-in approver";
  const fullName = [user.firstName, user.lastName]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  return fullName || user.username || "signed-in approver";
}

function CampaignActions({
  assistantId,
  campaign,
  selectedBrandId,
  preview,
  approvalPreview,
  reviewStale,
  externalWritesEnabled,
  sendEnabled,
}: {
  assistantId: string;
  campaign: RetentionCampaignSummary;
  selectedBrandId: string | null;
  preview: RetentionCampaignPreview;
  approvalPreview: RetentionCampaignApprovalPreview;
  reviewStale: boolean;
  externalWritesEnabled: boolean;
  sendEnabled: boolean;
}) {
  const approverName = useApproverDisplayName();
  const approvalMutation = useApproveRetentionCampaign(
    assistantId,
    selectedBrandId!,
  );
  const releaseMutation = useReleaseRetentionCampaign(
    assistantId,
    selectedBrandId!,
  );
  const [releaseKey, setReleaseKey] = useState<string | null>(null);

  const approvalResult =
    approvalMutation.data?.campaignId === campaign.id
      ? approvalMutation.data
      : null;
  const approvedChecksum = approvalResult
    ? approvalResult.snapshotSha256
    : preview.campaign.status === "approved"
      ? approvalPreview.snapshotSha256
      : null;
  const approvalChecksumChanged =
    approvedChecksum !== null &&
    approvedChecksum !== approvalPreview.snapshotSha256;
  const approved =
    approvedChecksum !== null && !approvalChecksumChanged && !reviewStale;
  const reviewable =
    preview.campaign.status === "review_required" &&
    !reviewStale &&
    !approvalMutation.isPending;
  const releasedOrTerminal = TERMINAL_OR_RELEASED_STATUSES.includes(
    preview.campaign.status,
  );
  const canSend =
    approved &&
    externalWritesEnabled &&
    sendEnabled &&
    !releasedOrTerminal &&
    !releaseMutation.isPending;

  const openSendConfirmation = () => {
    if (!canSend) return;
    releaseMutation.reset();
    setReleaseKey(
      `retention-send:${campaign.id}:${globalThis.crypto.randomUUID()}`,
    );
  };

  const confirmSend = () => {
    if (!releaseKey || !approvedChecksum || !canSend) return;
    releaseMutation.mutate(
      {
        campaignId: campaign.id,
        snapshotSha256: approvedChecksum,
        idempotencyKey: releaseKey,
      },
      {
        onSuccess: () => setReleaseKey(null),
      },
    );
  };

  return (
    <section
      className="border-t border-[var(--border-base)]"
      aria-label="Campaign release controls"
    >
      <div className="grid md:grid-cols-2">
        <div className="border-b border-[var(--border-base)] p-5 md:border-r md:border-b-0">
          <p className="text-label-small text-[var(--content-tertiary)]">
            1. APPROVAL
          </p>
          <h3 className="mt-2 text-title-small text-[var(--content-emphasised)]">
            Approve frozen content
          </h3>
          <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
            Your name and this exact checksum are recorded in the audit trail.
          </p>

          <div className="mt-5">
            <Button
              variant="primary"
              leftIcon={
                approvalMutation.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <FileCheck2 />
                )
              }
              disabled={!reviewable || approved}
              onClick={() =>
                approvalMutation.mutate({
                  campaignId: campaign.id,
                  expectedSnapshotSha256: approvalPreview.snapshotSha256,
                })
              }
            >
              {approved ? "Approved" : `Approve as ${approverName}`}
            </Button>
          </div>

          {approvalMutation.isError ? (
            <p
              className="mt-3 text-body-small-default text-[var(--system-negative-strong)]"
              role="alert"
            >
              {campaignErrorMessage(approvalMutation.error, "approve")}
            </p>
          ) : null}
          {approvalMutation.isSuccess ? (
            <p className="mt-3 flex items-center gap-2 text-body-small-default text-[var(--content-success)]">
              <Check className="size-4" aria-hidden="true" />
              Approved. Delivery is unlocked.
            </p>
          ) : null}
          {!reviewable &&
          !approved &&
          !approvalMutation.isError &&
          preview.campaign.status !== "review_required" ? (
            <p className="mt-3 text-body-small-default text-[var(--content-tertiary)]">
              This campaign is not awaiting approval.
            </p>
          ) : null}
        </div>

        <div className="p-5">
          <p className="text-label-small text-[var(--content-tertiary)]">
            2. DELIVERY
          </p>
          <h3 className="mt-2 text-title-small text-[var(--content-emphasised)]">
            Send via Klaviyo
          </h3>
          <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
            This is a separate irreversible action. Consent is checked again
            immediately before delivery.
          </p>

          <div className="mt-5">
            <Button
              variant="danger"
              leftIcon={
                releaseMutation.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Send />
                )
              }
              disabled={!canSend}
              onClick={openSendConfirmation}
            >
              Send via Klaviyo
            </Button>
          </div>

          {!externalWritesEnabled || !sendEnabled ? (
            <p className="mt-3 flex items-start gap-2 text-body-small-default text-[var(--content-tertiary)]">
              <LockKeyhole
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              Sending is blocked by workspace safety controls.
            </p>
          ) : null}
          {!approved &&
          externalWritesEnabled &&
          sendEnabled &&
          !releasedOrTerminal ? (
            <p className="mt-3 text-body-small-default text-[var(--content-tertiary)]">
              Approval must be completed first.
            </p>
          ) : null}
          {releasedOrTerminal ? (
            <p className="mt-3 text-body-small-default text-[var(--content-tertiary)]">
              This campaign has already entered the delivery workflow.
            </p>
          ) : null}
          {releaseMutation.isError ? (
            <p
              className="mt-3 text-body-small-default text-[var(--system-negative-strong)]"
              role="alert"
            >
              {campaignErrorMessage(releaseMutation.error, "send")}
            </p>
          ) : null}
          {releaseMutation.isSuccess ? (
            <p className="mt-3 flex items-center gap-2 text-body-small-default text-[var(--content-success)]">
              <Check className="size-4" aria-hidden="true" />
              Klaviyo delivery was queued.
            </p>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={releaseKey !== null}
        title="Send this campaign via Klaviyo?"
        message={
          <>
            This will release{" "}
            <strong>{preview.audience?.memberCount.toLocaleString() ?? "0"}</strong>{" "}
            personalized messages for <strong>{campaign.name}</strong>. This
            action cannot be undone after Klaviyo accepts recipients.
          </>
        }
        confirmLabel="Send via Klaviyo"
        destructive
        isPending={releaseMutation.isPending}
        onConfirm={confirmSend}
        onCancel={() => {
          if (!releaseMutation.isPending) setReleaseKey(null);
        }}
      />
    </section>
  );
}

function CampaignReviewDetail({
  assistantId,
  campaign,
  selectedBrandId,
  externalWritesEnabled,
  sendEnabled,
}: {
  assistantId: string;
  campaign: RetentionCampaignSummary;
  selectedBrandId: string | null;
  externalWritesEnabled: boolean;
  sendEnabled: boolean;
}) {
  const review = useRetentionCampaignReview(
    assistantId,
    campaign.id,
    selectedBrandId,
  );
  const preview = review.preview.data;
  const approvalPreview = review.approvalPreview.data;

  if (review.preview.isPending) {
    return (
      <div
        className="flex min-h-96 items-center justify-center"
        aria-label="Loading campaign review"
      >
        <Loader2 className="size-5 animate-spin text-[var(--content-tertiary)]" />
      </div>
    );
  }

  if (review.preview.isError || !preview) {
    return (
      <div className="flex min-h-96 flex-col items-center justify-center px-6 text-center">
        <AlertCircle className="size-7 text-[var(--system-warning-strong)]" />
        <h3 className="mt-4 text-title-small text-[var(--content-emphasised)]">
          Campaign review unavailable
        </h3>
        <p className="mt-2 max-w-md text-body-small-default text-[var(--content-tertiary)]">
          {campaignErrorMessage(review.preview.error, "review")}
        </p>
        <Button
          className="mt-5"
          variant="outlined"
          leftIcon={<RefreshCw />}
          onClick={() => void review.preview.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  }

  const reviewStale = approvalPreview
    ? isCampaignReviewStale(preview, approvalPreview)
    : false;
  const approvalUnavailable =
    review.approvalPreview.isError || !approvalPreview;

  return (
    <div className="min-w-0">
      <div className="px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-body-small-default text-[var(--content-tertiary)]">
              {preview.campaign.programName} {" | "}
              {formatProgram(preview.campaign.programType)}
            </p>
            <h2 className="mt-2 text-title-medium text-[var(--content-emphasised)]">
              {preview.campaign.name}
            </h2>
            <p className="mt-2 text-body-small-default text-[var(--content-tertiary)]">
              {formatCampaignMode(preview.campaign.mode)} {" | "} Revision{" "}
              {preview.campaign.revision} {" | "} Updated{" "}
              {formatDate(campaign.updatedAt)}
            </p>
          </div>
          <span
            className={`shrink-0 rounded-full border border-[var(--border-base)] px-3 py-1 text-body-small-default ${
              CAMPAIGN_STATUS[preview.campaign.status].className
            }`}
          >
            {CAMPAIGN_STATUS[preview.campaign.status].label}
          </span>
        </div>
      </div>

      <ReviewFacts
        campaign={campaign}
        preview={preview}
        approvalPreview={approvalPreview}
      />

      <section className="px-5 py-5" aria-labelledby="snapshot-heading">
        <div className="flex items-start gap-3">
          <LockKeyhole
            className="mt-0.5 size-5 shrink-0 text-[var(--content-secondary)]"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <h3
              id="snapshot-heading"
              className="text-title-small text-[var(--content-emphasised)]"
            >
              Frozen approval checksum
            </h3>
            {review.approvalPreview.isPending ? (
              <p className="mt-2 flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)]">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Verifying frozen campaign content
              </p>
            ) : approvalUnavailable ? (
              <p
                className="mt-2 text-body-small-default text-[var(--system-warning-strong)]"
                role="alert"
              >
                {campaignErrorMessage(
                  review.approvalPreview.error,
                  "review",
                )}
              </p>
            ) : (
              <code className="mt-2 block break-all text-body-small-default text-[var(--content-secondary)]">
                {approvalPreview.snapshotSha256}
              </code>
            )}
            {reviewStale ? (
              <p
                className="mt-3 flex items-start gap-2 text-body-small-default text-[var(--system-negative-strong)]"
                role="alert"
              >
                <AlertCircle
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                The campaign changed while this review was open. Refresh before
                approving or sending.
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <div className="px-5 pb-6">
        <RepresentativeSamples preview={preview} />
      </div>

      {approvalPreview && !approvalUnavailable ? (
        <CampaignActions
          assistantId={assistantId}
          campaign={campaign}
          selectedBrandId={selectedBrandId}
          preview={preview}
          approvalPreview={approvalPreview}
          reviewStale={reviewStale}
          externalWritesEnabled={externalWritesEnabled}
          sendEnabled={sendEnabled}
        />
      ) : (
        <section className="border-t border-[var(--border-base)] px-5 py-5">
          <p className="flex items-start gap-2 text-body-small-default text-[var(--content-tertiary)]">
            <LockKeyhole
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            Approval and sending stay locked until the frozen snapshot is
            verified.
          </p>
        </section>
      )}
    </div>
  );
}

export function RetentionCampaignReview({
  assistantId,
  selectedBrandId,
  retentionStatus,
}: {
  assistantId: string;
  selectedBrandId: string | null;
  retentionStatus: Pick<
    RetentionStatus,
    "externalWritesEnabled" | "sendEnabled"
  > | null;
}) {
  const campaignsQuery = useRetentionCampaigns(assistantId, selectedBrandId);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(
    null,
  );
  const campaigns = useMemo(
    () => campaignsQuery.data ?? [],
    [campaignsQuery.data],
  );

  useEffect(() => {
    if (!selectedBrandId) {
      if (selectedCampaignId !== null) {
        setSelectedCampaignId(null);
      }
      return;
    }
    if (campaigns.length === 0) {
      setSelectedCampaignId(null);
      return;
    }
    if (
      !selectedCampaignId ||
      !campaigns.some((campaign) => campaign.id === selectedCampaignId)
    ) {
      setSelectedCampaignId(campaigns[0]?.id ?? null);
    }
  }, [campaigns, selectedBrandId, selectedCampaignId]);

  if (!selectedBrandId) {
    return (
      <section
        className="mx-auto flex w-full max-w-5xl flex-col gap-4 rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] p-6"
        aria-label="Select a retention brand"
      >
        <h2 className="text-title-small text-[var(--content-emphasised)]">
          Select a brand
        </h2>
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          Choose a brand first so each campaign list stays isolated.
        </p>
      </section>
    );
  }

  const selectedCampaign = selectedBrandId
    ? campaigns.find((campaign) => campaign.id === selectedCampaignId) ?? null
    : null;

  return (
    <section aria-labelledby="campaign-review-heading">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2
            id="campaign-review-heading"
            className="text-title-small text-[var(--content-emphasised)]"
          >
            Campaign review
          </h2>
          <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
            Review frozen audiences and finished messages before approval.
          </p>
        </div>
        <Button
          variant="outlined"
          size="compact"
          iconOnly={
            <RefreshCw
              className={campaignsQuery.isFetching ? "animate-spin" : ""}
            />
          }
          aria-label="Refresh campaigns"
          title="Refresh campaigns"
          disabled={campaignsQuery.isFetching}
          onClick={() => void campaignsQuery.refetch()}
        />
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] lg:grid lg:grid-cols-[minmax(15rem,0.72fr)_minmax(0,2fr)]">
        <aside className="border-b border-[var(--border-base)] lg:border-r lg:border-b-0">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--border-base)] px-4 py-3">
            <span className="text-label-small text-[var(--content-tertiary)]">
              CAMPAIGNS
            </span>
            <span className="text-body-small-default tabular-nums text-[var(--content-tertiary)]">
              {campaigns.length}
            </span>
          </div>

          {campaignsQuery.isPending ? (
            <div
              className="flex min-h-48 items-center justify-center"
              aria-label="Loading retention campaigns"
            >
              <Loader2 className="size-5 animate-spin text-[var(--content-tertiary)]" />
            </div>
          ) : null}
          {campaignsQuery.isError ? (
            <div className="px-5 py-10 text-center" role="alert">
              <AlertCircle className="mx-auto size-6 text-[var(--system-warning-strong)]" />
              <p className="mt-3 text-body-small-default text-[var(--content-tertiary)]">
                {campaignErrorMessage(campaignsQuery.error, "list")}
              </p>
              <Button
                className="mt-4"
                variant="outlined"
                size="compact"
                leftIcon={<RefreshCw />}
                onClick={() => void campaignsQuery.refetch()}
              >
                Try again
              </Button>
            </div>
          ) : null}
          {campaignsQuery.data ? (
            <CampaignListState
              campaigns={campaigns}
              selectedCampaignId={selectedCampaignId}
              onSelect={setSelectedCampaignId}
            />
          ) : null}
        </aside>

        <div className="min-w-0">
          {selectedCampaign ? (
          <CampaignReviewDetail
            key={selectedCampaign.id}
            assistantId={assistantId}
            campaign={selectedCampaign}
            selectedBrandId={selectedBrandId}
            externalWritesEnabled={
              retentionStatus?.externalWritesEnabled ?? false
            }
              sendEnabled={retentionStatus?.sendEnabled ?? false}
            />
          ) : (
            <div className="flex min-h-96 flex-col items-center justify-center px-6 text-center">
              <Clock3 className="size-6 text-[var(--content-tertiary)]" />
              <p className="mt-3 text-body-small-default text-[var(--content-tertiary)]">
                Select a campaign when one is ready for review.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
