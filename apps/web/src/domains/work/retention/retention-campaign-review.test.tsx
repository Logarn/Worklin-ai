import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import type {
  RetentionCampaignApprovalPreview,
  RetentionCampaignPreview,
  RetentionCampaignSummary,
} from "./retention-api";
import { RetentionApiError } from "./retention-api";

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const AUDIENCE_ID = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_SHA256 = "a".repeat(64);
const AUDIENCE_SHA256 = "b".repeat(64);

const campaignsRefetch = mock(async () => {});
const previewRefetch = mock(async () => {});
const approvalPreviewRefetch = mock(async () => {});
const approveMutate = mock((_variables: unknown) => {});
const approveReset = mock(() => {});
const releaseMutate = mock((_variables: unknown, _options?: unknown) => {});
const releaseReset = mock(() => {});

let campaignsQuery: Record<string, unknown>;
let reviewQuery: {
  preview: Record<string, unknown>;
  approvalPreview: Record<string, unknown>;
};
let approvalMutation: Record<string, unknown>;
let releaseMutation: Record<string, unknown>;

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    use: {
      user: () => ({
        id: "user-1",
        username: "approver",
        email: "user@example.com",
        isStaff: false,
        firstName: "Example",
        lastName: "Approver",
      }),
    },
  },
}));

mock.module("./use-retention-campaigns", () => ({
  useRetentionCampaigns: () => campaignsQuery,
  useRetentionCampaignReview: () => reviewQuery,
  useApproveRetentionCampaign: () => approvalMutation,
  useReleaseRetentionCampaign: () => releaseMutation,
}));

const { RetentionCampaignReview } =
  await import("./retention-campaign-review");

function campaign(
  overrides: Partial<RetentionCampaignSummary> = {},
): RetentionCampaignSummary {
  return {
    id: CAMPAIGN_ID,
    programName: "First purchase",
    programType: "non_buyer_conversion",
    name: "July conversion",
    mode: "individual_message",
    status: "review_required",
    revision: 3,
    audienceMemberCount: 12,
    sensitiveMemberCount: 2,
    renderedMessageCount: 12,
    dispatchStatus: null,
    acceptedCount: 0,
    failedCount: 0,
    estimatedCostUsd: 1.25,
    updatedAt: "2026-07-28T10:00:00.000Z",
    ...overrides,
  };
}

function preview(
  overrides: Partial<RetentionCampaignPreview> = {},
): RetentionCampaignPreview {
  return {
    campaign: {
      id: CAMPAIGN_ID,
      name: "July conversion",
      mode: "individual_message",
      status: "review_required",
      revision: 3,
      programName: "First purchase",
      programType: "non_buyer_conversion",
      approvedAt: null,
    },
    audience: {
      id: AUDIENCE_ID,
      memberCount: 12,
      sensitiveMemberCount: 2,
      snapshotSha256: AUDIENCE_SHA256,
      frozenAt: "2026-07-28T09:00:00.000Z",
    },
    messageSamples: [
      {
        qualityStatus: "passed",
        subject: "A useful subject",
        preheader: "A useful preheader",
        body: "A concise useful message.",
        bodyTruncated: false,
        contentWithheld: false,
      },
      {
        qualityStatus: "needs_review",
        subject: null,
        preheader: null,
        body: null,
        bodyTruncated: false,
        contentWithheld: true,
      },
    ],
    ...overrides,
  };
}

function approvalPreview(
  overrides: Partial<RetentionCampaignApprovalPreview> = {},
): RetentionCampaignApprovalPreview {
  return {
    snapshotSha256: SNAPSHOT_SHA256,
    campaignId: CAMPAIGN_ID,
    campaignRevision: 3,
    program: "non_buyer_conversion",
    mode: "individual_message",
    audienceSnapshotId: AUDIENCE_ID,
    audienceChecksum: AUDIENCE_SHA256,
    recipientDecisionCount: 12,
    contentCount: 12,
    modelReferences: ["provider:model"],
    promptReferences: ["retention-v1"],
    offerChecksum: "c".repeat(64),
    ...overrides,
  };
}

function setReadyState({
  campaignValue = campaign(),
  previewValue = preview(),
  approvalPreviewValue = approvalPreview(),
}: {
  campaignValue?: RetentionCampaignSummary;
  previewValue?: RetentionCampaignPreview;
  approvalPreviewValue?: RetentionCampaignApprovalPreview;
} = {}) {
  campaignsQuery = {
    data: [campaignValue],
    error: null,
    isError: false,
    isFetching: false,
    isPending: false,
    refetch: campaignsRefetch,
  };
  reviewQuery = {
    preview: {
      data: previewValue,
      error: null,
      isError: false,
      isPending: false,
      refetch: previewRefetch,
    },
    approvalPreview: {
      data: approvalPreviewValue,
      error: null,
      isError: false,
      isPending: false,
      refetch: approvalPreviewRefetch,
    },
  };
  approvalMutation = {
    data: undefined,
    error: null,
    isError: false,
    isPending: false,
    isSuccess: false,
    mutate: approveMutate,
    reset: approveReset,
  };
  releaseMutation = {
    data: undefined,
    error: null,
    isError: false,
    isPending: false,
    isSuccess: false,
    mutate: releaseMutate,
    reset: releaseReset,
  };
}

function renderReview(
  retentionStatus: {
    externalWritesEnabled: boolean;
    sendEnabled: boolean;
  } | null = {
    externalWritesEnabled: false,
    sendEnabled: false,
  },
) {
  return render(
    <RetentionCampaignReview
      assistantId="assistant-1"
      retentionStatus={retentionStatus}
    />,
  );
}

describe("RetentionCampaignReview", () => {
  beforeEach(() => {
    setReadyState();
    campaignsRefetch.mockClear();
    previewRefetch.mockClear();
    approvalPreviewRefetch.mockClear();
    approveMutate.mockClear();
    approveReset.mockClear();
    releaseMutate.mockClear();
    releaseReset.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("shows frozen review facts and representative samples without customer intelligence", async () => {
    renderReview();

    await waitFor(() =>
      expect(screen.getAllByText("July conversion")).toHaveLength(2),
    );
    expect(screen.getByText(SNAPSHOT_SHA256)).toBeTruthy();
    expect(screen.getAllByText("12").length).toBeGreaterThan(0);
    expect(screen.getByText("$1.25")).toBeTruthy();
    expect(screen.getByText("A useful subject")).toBeTruthy();
    expect(screen.getByText("Sensitive content withheld")).toBeTruthy();
    expect(screen.queryByText("provider:model")).toBeNull();
    expect(screen.queryByText("customer_private")).toBeNull();
  });

  test("approves only the checksum currently under review and names the approver", async () => {
    renderReview();

    const button = await screen.findByRole("button", {
      name: "Approve as Example Approver",
    });
    fireEvent.click(button);

    expect(approveMutate).toHaveBeenCalledWith({
      campaignId: CAMPAIGN_ID,
      expectedSnapshotSha256: SNAPSHOT_SHA256,
    });
    expect(releaseMutate).not.toHaveBeenCalled();
  });

  test("requires a separate destructive confirmation before Klaviyo release", async () => {
    setReadyState({
      campaignValue: campaign({ status: "approved" }),
      previewValue: preview({
        campaign: {
          ...preview().campaign,
          status: "approved",
          approvedAt: "2026-07-28T10:30:00.000Z",
        },
      }),
    });
    renderReview({ externalWritesEnabled: true, sendEnabled: true });

    const releaseButton = await screen.findByRole("button", {
      name: "Send via Klaviyo",
    });
    fireEvent.click(releaseButton);

    expect(releaseMutate).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/This action cannot be undone/),
    ).toBeTruthy();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Send via Klaviyo" }),
    );

    expect(releaseMutate).toHaveBeenCalledTimes(1);
    const variables = releaseMutate.mock.calls[0]?.[0] as {
      campaignId: string;
      snapshotSha256: string;
      idempotencyKey: string;
    };
    expect(variables.campaignId).toBe(CAMPAIGN_ID);
    expect(variables.snapshotSha256).toBe(SNAPSHOT_SHA256);
    expect(variables.idempotencyKey).toStartWith(
      `retention-send:${CAMPAIGN_ID}:`,
    );
    expect(variables.idempotencyKey.length).toBeGreaterThan(16);
  });

  test("locks approval and sending when the review snapshot is stale", async () => {
    setReadyState({
      campaignValue: campaign({ status: "approved" }),
      previewValue: preview({
        campaign: {
          ...preview().campaign,
          status: "approved",
          approvedAt: "2026-07-28T10:30:00.000Z",
        },
      }),
      approvalPreviewValue: approvalPreview({
        audienceChecksum: "f".repeat(64),
      }),
    });
    renderReview({ externalWritesEnabled: true, sendEnabled: true });

    expect(
      await screen.findByText(
        "The campaign changed while this review was open. Refresh before approving or sending.",
      ),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Send via Klaviyo",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test("shows a human approval error without exposing service details", async () => {
    approvalMutation = {
      data: undefined,
      error: new RetentionApiError(
        409,
        "database snapshot material did not match",
        "approval_invalidated",
      ),
      isError: true,
      isPending: false,
      isSuccess: false,
      mutate: approveMutate,
      reset: approveReset,
    };
    renderReview();

    expect(
      await screen.findByText(
        "The campaign changed while it was open. Refresh it before continuing.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("database snapshot material did not match"),
    ).toBeNull();
  });
});
