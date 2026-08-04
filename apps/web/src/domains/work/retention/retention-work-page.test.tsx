import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { RetentionStatus } from "./retention-api";

type QueryState = {
  data?: RetentionStatus;
  error?: unknown;
  isError: boolean;
  isFetching: boolean;
  isPending: boolean;
  refetch: ReturnType<typeof mock>;
};

const refetch = mock(async () => {});
let queryState: QueryState;

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));

mock.module("@/components/layout/chat-layout-slots-store", () => ({
  useChatLayoutSlotsStore: {
    use: { setTopBarCenter: () => mock((_value: unknown) => {}) },
  },
}));

mock.module("./use-retention-status", () => ({
  useRetentionStatus: () => queryState,
}));

mock.module("./retention-campaign-review", () => ({
  RetentionCampaignReview: () => <div>Campaign review test surface</div>,
}));

const { RetentionWorkPage, formatIngestionLag } =
  await import("./retention-work-page");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/assistant/work/retention"]}>
      <RetentionWorkPage />
    </MemoryRouter>,
  );
}

describe("RetentionWorkPage", () => {
  afterEach(() => {
    cleanup();
    refetch.mockClear();
  });

  test("shows clear loading and empty states", () => {
    queryState = {
      isError: false,
      isFetching: false,
      isPending: true,
      refetch,
    };
    const view = renderPage();

    expect(screen.getByText("Campaign review test surface")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Data health" }));
    expect(screen.getByLabelText("Loading retention health")).toBeTruthy();

    view.unmount();
    queryState = {
      data: {
        integrations: [],
        jobs: {},
        externalWritesEnabled: false,
        sendEnabled: false,
      },
      isError: false,
      isFetching: false,
      isPending: false,
      refetch,
    };
    renderPage();

    fireEvent.click(screen.getByRole("tab", { name: "Data health" }));
    expect(screen.getByText("No sources connected")).toBeTruthy();
    expect(screen.getAllByText("Not connected")).toHaveLength(2);
    expect(screen.getByText("Queue is clear")).toBeTruthy();
  });

  test("offers the audiences workspace alongside campaigns and setup", () => {
    queryState = {
      data: {
        integrations: [],
        jobs: {},
        externalWritesEnabled: false,
        sendEnabled: false,
      },
      isError: false,
      isFetching: false,
      isPending: false,
      refetch,
    };
    renderPage();

    expect(
      screen
        .getByRole("tab", { name: "Audiences" })
        .getAttribute("aria-selected"),
    ).toBe("false");
  });

  test("formats ingestion freshness for operators", () => {
    const now = Date.parse("2026-07-28T12:00:00.000Z");

    expect(formatIngestionLag("2026-07-28T11:59:30.000Z", now)).toBe(
      "Under a minute",
    );
    expect(formatIngestionLag("2026-07-28T11:55:00.000Z", now)).toBe(
      "5 minutes",
    );
    expect(formatIngestionLag(null, now)).toBe("No activity yet");
  });

  test("shows source, queue, and safety posture without customer data", () => {
    queryState = {
      data: {
        integrations: [
          {
            provider: "shopify",
            status: "active",
            lastWebhookAt: new Date().toISOString(),
            lastPolledAt: null,
            lastReconciledAt: null,
            lastErrorCode: null,
          },
          {
            provider: "klaviyo",
            status: "degraded",
            lastWebhookAt: null,
            lastPolledAt: null,
            lastReconciledAt: null,
            lastErrorCode: "provider_timeout",
          },
        ],
        jobs: { queued: 4, running: 1, failed: 2, dead_letter: 1 },
        externalWritesEnabled: false,
        sendEnabled: false,
      },
      isError: false,
      isFetching: false,
      isPending: false,
      refetch,
    };

    renderPage();

    fireEvent.click(screen.getByRole("tab", { name: "Data health" }));
    expect(screen.getByText("Shopify")).toBeTruthy();
    expect(screen.getByText("Klaviyo")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getAllByText("Needs attention")).toHaveLength(2);
    expect(
      screen.getByText("Changes to connected services are blocked."),
    ).toBeTruthy();
    expect(
      screen.getByText("Sending through Klaviyo is blocked."),
    ).toBeTruthy();
    expect(screen.getAllByText("Blocked")).toHaveLength(2);
    expect(screen.queryByText("provider_timeout")).toBeNull();
  });

  test("offers a retry without exposing service errors", () => {
    queryState = {
      error: new Error("postgres connection string"),
      isError: true,
      isFetching: false,
      isPending: false,
      refetch,
    };

    renderPage();

    fireEvent.click(screen.getByRole("tab", { name: "Data health" }));
    expect(screen.getByText("Retention status unavailable")).toBeTruthy();
    expect(screen.queryByText("postgres connection string")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
