import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

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
let queriedAssistantId: string | null = null;
let queriedBrandId: string | null = null;
const workDataState = {
  brands: [
    {
      id: "brand-rachaa",
      name: "Dr Rachael",
      copybookCount: 0,
      artifactCount: 0,
    },
    {
      id: "brand-sea",
      name: "Sea Moss",
      copybookCount: 0,
      artifactCount: 0,
    },
  ],
  isLoading: false,
  hasPartialError: false,
};
const unassignedBrand = {
  id: "unassigned",
  name: "Unassigned",
  copybookCount: 0,
  artifactCount: 2,
};

mock.module("@/components/layout/chat-layout-slots-store", () => ({
  useChatLayoutSlotsStore: {
    use: { setTopBarCenter: () => mock((_value: unknown) => {}) },
  },
}));

mock.module("./use-retention-status", () => ({
  useRetentionStatus: (assistantId: string, selectedBrandId: string | null) => {
    queriedAssistantId = assistantId;
    queriedBrandId = selectedBrandId;
    return queryState;
  },
}));

mock.module("../use-work-data", () => ({
  UNASSIGNED_BRAND_ID: "unassigned",
  useWorkData: () => workDataState,
}));

const { RetentionWorkPage, formatIngestionLag } =
  await import("./retention-work-page");

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

function renderPage() {
  queryClient.clear();
  return render(
    <MemoryRouter initialEntries={["/assistant/work/retention"]}>
      <QueryClientProvider client={queryClient}>
        <RetentionWorkPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("RetentionWorkPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useResolvedAssistantsStore.setState({
      activeAssistantId: "assistant-1",
      selectedAssistantId: "assistant-1",
    });
    queriedAssistantId = null;
    queriedBrandId = null;
  });

  afterEach(() => {
    cleanup();
    refetch.mockClear();
  });

  test("uses the selected assistant while its chat runtime is unavailable", () => {
    useResolvedAssistantsStore.setState({
      activeAssistantId: null,
      selectedAssistantId: "assistant-selected",
    });
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

    expect(queriedAssistantId).toBe("assistant-selected");
    expect(queriedBrandId).toBe("brand-rachaa");
    expect(screen.getByText("Campaigns")).toBeTruthy();
  });

  test("shows a safe waiting state when no assistant is selected", () => {
    useResolvedAssistantsStore.setState({
      activeAssistantId: null,
      selectedAssistantId: null,
    });

    renderPage();

    expect(
      screen.getByText("Customer decisions is getting ready"),
    ).toBeTruthy();
    expect(queriedAssistantId).toBeNull();
    expect(queriedBrandId).toBeNull();
  });

  test("shows clear loading and empty states", () => {
    queryState = {
      isError: false,
      isFetching: false,
      isPending: true,
      refetch,
    };
    const view = renderPage();

    expect(screen.getByText("Campaigns")).toBeTruthy();
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

  test("ignores Unassigned in brand selection", () => {
    const originalBrands = workDataState.brands;
    workDataState.brands = [unassignedBrand];
    try {
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

      expect(screen.queryByLabelText("Retention brand selector")).toBeNull();
      expect(screen.getByText("Connect the customer data first")).toBeTruthy();
      expect(screen.queryByText("Unassigned")).toBeNull();
    } finally {
      workDataState.brands = originalBrands;
    }
  });

  test("starts in setup with clear actions when no brand is connected", async () => {
    const originalBrands = workDataState.brands;
    workDataState.brands = [];
    try {
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

      await waitFor(() =>
        expect(
          screen
            .getByRole("tab", { name: "Setup" })
            .getAttribute("aria-selected"),
        ).toBe("true"),
      );
      expect(
        screen
          .getAllByRole("link", { name: "Connect Klaviyo" })[0]
          ?.getAttribute("href"),
      ).toBe("/assistant/settings/integrations?provider=klaviyo");
      expect(
        screen
          .getAllByRole("link", { name: "Add brand context" })[0]
          ?.getAttribute("href"),
      ).toBe("/assistant/work");
      expect(
        screen.getByText(/before Worklin prepares micro-segments/iu),
      ).toBeTruthy();
      expect(screen.getByText("Connect the customer data first")).toBeTruthy();
    } finally {
      workDataState.brands = originalBrands;
    }
  });

  test("uses connected retention brands when Work has no artifacts yet", async () => {
    const originalBrands = workDataState.brands;
    workDataState.brands = [];

    queryState = {
      data: {
        integrations: [
          {
            brandId: "00000000-0000-4000-8000-000000000123",
            brandName: "Connected Klaviyo Brand",
            provider: "klaviyo",
            status: "active",
            lastWebhookAt: null,
            lastPolledAt: null,
            lastReconciledAt: null,
            lastErrorCode: null,
          },
        ],
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

    await waitFor(() =>
      expect(screen.getByLabelText("Retention brand selector")).toBeTruthy(),
    );
    expect(screen.getByText("Connected Klaviyo Brand")).toBeTruthy();
    expect(screen.queryByText("Connect at least one brand in Work")).toBeNull();
    await waitFor(() =>
      expect(queriedBrandId).toBe("00000000-0000-4000-8000-000000000123"),
    );

    workDataState.brands = originalBrands;
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
            brandId: "brand-rachaa",
            brandName: "Dr Rachael",
            provider: "shopify",
            status: "active",
            lastWebhookAt: new Date().toISOString(),
            lastPolledAt: null,
            lastReconciledAt: null,
            lastErrorCode: null,
          },
          {
            brandId: "brand-rachaa",
            brandName: "Dr Rachael",
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
