import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

const importRefetch = mock(async () => {});
const segmentRefetch = mock(async () => {});
const setActiveConversationId = mock((_id: string) => {});
const setMainView = mock((_view: string) => {});
const startMutate = mock(
  (
    _input: unknown,
    _options?: { onSuccess?: (run: Record<string, unknown>) => void },
  ) => {},
);

let audiencesState: Record<string, unknown>;
let runState: Record<string, unknown>;
let startState: Record<string, unknown>;

mock.module("./use-retention-audiences", () => ({
  useRetentionAudiences: () => audiencesState,
  useRetentionSegmentRun: () => runState,
  useStartRetentionSegmentRun: () => startState,
}));
mock.module("@/stores/conversation-store", () => ({
  useConversationStore: {
    getState: () => ({ setActiveConversationId }),
  },
}));
mock.module("@/stores/viewer-store", () => ({
  useViewerStore: {
    getState: () => ({ setMainView }),
  },
}));
mock.module("@/utils/conversation-selection", () => ({
  createDraftConversationId: () => "draft-retention-review",
}));

const { RetentionAudiences, retentionAudienceSummaryCsv } =
  await import("./retention-audiences");

const BRAND_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function emptyQueryState() {
  return {
    data: [],
    error: null,
    isError: false,
    isPending: false,
    refetch: segmentRefetch,
  };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <output
      data-testid="location"
      data-pathname={location.pathname}
      data-search={location.search}
    />
  );
}

function renderAudiences() {
  return render(
    <MemoryRouter initialEntries={["/assistant/work/retention"]}>
      <LocationProbe />
      <Routes>
        <Route
          path="/assistant/work/retention"
          element={<RetentionAudiences assistantId="assistant-1" />}
        />
        <Route path="/assistant/conversations/:conversationId" element={null} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  importRefetch.mockClear();
  segmentRefetch.mockClear();
  startMutate.mockClear();
  setActiveConversationId.mockClear();
  setMainView.mockClear();
});

describe("RetentionAudiences", () => {
  test("exports a non-PII audience summary", () => {
    const csv = retentionAudienceSummaryCsv([
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        name: 'Recent browsers, "high intent"',
        description: "People showing current product interest.",
        totalCount: 18,
        eligibleCount: 16,
        evidence: [
          {
            signal: "Recent product view",
            explanation: "Viewed a product in the last seven days",
            strength: "strong",
            source: "event",
          },
        ],
        confidence: 0.82,
        changeSincePriorRun: 3,
        campaignConcept: {
          objective: "Turn active interest into a first order.",
          angle: "Help them compare the options they explored.",
          timing: "Within two days",
          callToAction: "Find your best fit",
        },
        sampleMessages: [],
        updatedAt: "2026-08-04T10:01:00.000Z",
      },
    ]);

    expect(csv).toContain('"Recent browsers, ""high intent"""');
    expect(csv).toContain("82");
    expect(csv).not.toContain("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(csv).not.toContain("email address");
  });

  test("keeps the disconnected state clear and review only", () => {
    audiencesState = {
      brandId: null,
      imports: {
        data: [],
        error: null,
        isError: false,
        isPending: false,
        refetch: importRefetch,
      },
      segments: emptyQueryState(),
    };
    runState = { data: undefined, error: null, isError: false };
    startState = {
      data: undefined,
      error: null,
      isError: false,
      isPending: false,
      mutate: startMutate,
    };

    renderAudiences();

    expect(screen.getByText("Review only")).toBeTruthy();
    expect(screen.getByText("Connect Klaviyo first")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /send/iu })).toBeNull();
    expect(screen.queryByRole("button", { name: /approve/iu })).toBeNull();
  });

  test("resumes in chat with exact safe tool identifiers", async () => {
    audiencesState = {
      brandId: BRAND_ID,
      imports: {
        data: [],
        error: null,
        isError: false,
        isPending: false,
        refetch: importRefetch,
      },
      segments: emptyQueryState(),
    };
    runState = {
      data: {
        id: RUN_ID,
        brandId: BRAND_ID,
        status: "paused",
        maxSegments: 10,
        sampleLimitPerSegment: 2,
        completedSegments: 4,
        totalSegments: 10,
        lastErrorCode: "model_usage_limited",
        startedAt: "2026-08-04T10:00:00.000Z",
        completedAt: null,
        updatedAt: "2026-08-04T10:01:00.000Z",
      },
      error: null,
      isError: false,
    };
    startState = {
      data: undefined,
      error: null,
      isError: false,
      isPending: false,
      mutate: startMutate,
    };
    const successfulRun = {
      id: RUN_ID,
      brandId: BRAND_ID,
      status: "paused",
      maxSegments: 25,
      sampleLimitPerSegment: 2,
      completedSegments: 4,
      totalSegments: 25,
      lastErrorCode: "model_usage_limited",
      updatedAt: "2026-08-04T10:01:00.000Z",
    };

    renderAudiences();

    expect(screen.getByText("Paused safely")).toBeTruthy();
    expect(screen.getByText("4 of 10 audiences prepared")).toBeTruthy();
    expect(
      screen
        .getByRole("progressbar", { name: "Audience review progress" })
        .getAttribute("aria-valuenow"),
    ).toBe("40");
    fireEvent.change(screen.getByLabelText("Audience limit"), {
      target: { value: "25" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Resume review" }));
    expect(startMutate).toHaveBeenCalledWith(
      {
        brandId: BRAND_ID,
        maxSegments: 25,
        sampleLimitPerSegment: 2,
      },
      expect.any(Object),
    );
    const mutationOptions = startMutate.mock.calls[0]?.[1];
    await act(async () => {
      mutationOptions?.onSuccess?.(successfulRun);
    });
    await waitFor(() => {
      expect(screen.getByTestId("location").dataset.pathname).toBe(
        "/assistant/conversations/draft-retention-review",
      );
    });
    expect(setActiveConversationId).toHaveBeenCalledWith(
      "draft-retention-review",
    );
    expect(setMainView).toHaveBeenCalledWith("chat");
    const search = new URLSearchParams(
      screen.getByTestId("location").dataset.search,
    );
    const prompt = search.get("prompt") ?? "";
    expect(prompt).toContain("retention_campaign_review_pilot");
    expect(prompt).toContain(`brand_id=${BRAND_ID}`);
    expect(prompt).toContain(`run_id=${RUN_ID}`);
    expect(prompt).toContain("review-only");
    expect(prompt).toContain(
      "Do not create, update, or send anything in Klaviyo",
    );
    expect(prompt).not.toContain("credential");
    expect(prompt).not.toContain("email");
  });

  test("renders useful evidence, campaign direction, and responsive samples", () => {
    audiencesState = {
      brandId: BRAND_ID,
      imports: {
        data: [],
        error: null,
        isError: false,
        isPending: false,
        refetch: importRefetch,
      },
      segments: {
        ...emptyQueryState(),
        data: [
          {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            name: "Recent product browsers",
            description: "People showing recent interest but no purchase yet.",
            totalCount: 18,
            eligibleCount: 16,
            evidence: [
              {
                signal: "Recent product view",
                explanation: "Viewed a product in the last seven days",
                strength: "strong",
                source: "event",
              },
              {
                signal: "No purchase",
                explanation: "Has not placed an order",
                strength: "strong",
                source: "metric",
              },
            ],
            confidence: 0.82,
            changeSincePriorRun: 3,
            campaignConcept: {
              objective: "Turn active interest into a first order.",
              angle: "Lead with the product category they explored.",
              timing: "Within two days",
              callToAction: "Find your best fit",
            },
            sampleMessages: [
              {
                subject: "Still deciding?",
                preheader: "A simple way to choose",
                body: "Here is a clearer way to find the right option.",
                explanation: "Supports an active product decision.",
                qualityStatus: "passed",
              },
              {
                subject: "A useful next step",
                preheader: null,
                body: "Start with what matters most to you.",
                explanation: "Keeps the next step simple.",
                qualityStatus: "needs_review",
              },
            ],
            updatedAt: "2026-08-04T10:01:00.000Z",
          },
        ],
      },
    };
    runState = { data: undefined, error: null, isError: false };
    startState = {
      data: undefined,
      error: null,
      isError: false,
      isPending: false,
      mutate: startMutate,
    };

    renderAudiences();

    const heading = screen.getByText("Recent product browsers");
    const article = heading.closest("article");
    expect(article).toBeTruthy();
    expect(screen.getByText("18")).toBeTruthy();
    expect(screen.getByText("16")).toBeTruthy();
    expect(screen.getByText("High confidence · 82%")).toBeTruthy();
    expect(
      screen.getByText("Turn active interest into a first order."),
    ).toBeTruthy();
    expect(screen.getByText("Still deciding?")).toBeTruthy();
    expect(screen.getByText("Needs review")).toBeTruthy();
    expect(article?.querySelector("dl")?.className).toContain("sm:grid-cols-3");
    const samples = screen.getByLabelText(
      "Message samples for Recent product browsers",
    );
    expect(samples.querySelector('[class*="lg:grid-cols-2"]')).toBeTruthy();
  });
});
