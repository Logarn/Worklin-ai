import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";

import type { BrandResearchRun } from "@/lib/brand-research";

const ASSISTANT_ID = "assistant-1";
let runs: BrandResearchRun[] = [];
const enqueueCalls: Array<{
  assistantId: string;
  brandName?: string;
  websiteUrl?: string;
}> = [];
const cancelCalls: string[] = [];
const retryCalls: string[] = [];

mock.module("@/lib/brand-research", () => ({
  listBrandResearchRuns: async () => runs,
  enqueueBrandResearchRun: async (input: (typeof enqueueCalls)[number]) => {
    enqueueCalls.push(input);
    return null;
  },
  cancelBrandResearchRun: async (runId: string) => {
    cancelCalls.push(runId);
    return null;
  },
  retryBrandResearchRun: async (runId: string) => {
    retryCalls.push(runId);
    return null;
  },
}));

const { BrandResearchStatus } = await import("./brand-research-status");

function run(overrides: Partial<BrandResearchRun> = {}): BrandResearchRun {
  return {
    id: "research-1",
    assistant_id: ASSISTANT_ID,
    brand_name: "Brand research",
    website_url: null,
    seed_missing_reason: "seedMissing",
    brand_brain_id: null,
    status: "complete",
    tracks: [],
    evidence_count: 0,
    created_at: "2026-07-29T00:00:00.000Z",
    updated_at: "2026-07-29T00:00:00.000Z",
    error: null,
    ...overrides,
  };
}

function renderStatus(brandName?: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const renderResult = render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(BrandResearchStatus, {
        assistantId: ASSISTANT_ID,
        ...(brandName === undefined ? {} : { brandName }),
      }),
    ),
  );
  return { queryClient, ...renderResult };
}

beforeEach(() => {
  runs = [];
  enqueueCalls.length = 0;
  cancelCalls.length = 0;
  retryCalls.length = 0;
});

afterEach(() => cleanup());

describe("BrandResearchStatus", () => {
  test("lets a user start research after skipping the onboarding brand step", async () => {
    runs = [run()];
    renderStatus();

    expect(await screen.findByText("Brand research is ready")).toBeTruthy();
    const startButton = screen.getByRole("button", {
      name: "Start research",
    }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Brand name"), {
      target: { value: "Acme Studio" },
    });
    fireEvent.change(screen.getByLabelText("Public website"), {
      target: { value: "acme.example" },
    });
    fireEvent.click(startButton);

    await waitFor(() => {
      expect(enqueueCalls).toEqual([
        {
          assistantId: ASSISTANT_ID,
          brandName: "Acme Studio",
          websiteUrl: "acme.example",
        },
      ]);
    });
  });

  test("shows the matching track progress and retry control for partial runs", async () => {
    runs = [
      run({
        brand_name: "Acme Studio",
        seed_missing_reason: null,
        status: "partial",
        tracks: ["social"],
        track_progress: {
          social: {
            track: "social",
            status: "partial",
            evidence_count: 1,
            evidence_ids: ["social-1"],
            provider_usage: ["public-web"],
            provider_gaps: ["Instagram history was not observable."],
            started_at: "2026-07-29T00:00:00.000Z",
            completed_at: "2026-07-29T00:01:00.000Z",
            error: null,
          },
        },
      }),
    ];
    renderStatus();

    expect(
      await screen.findByText("Acme Studio: some results are ready"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Social media: Some results ready - Some information could not be found.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(retryCalls).toEqual(["research-1"]);
    });
  });

  test("shows the current brand instead of a newer run for another brand", async () => {
    runs = [
      run({
        id: "sea-moss-run",
        brand_name: "Sea Moss Only",
        seed_missing_reason: null,
        status: "queued",
        updated_at: "2026-07-30T10:00:00.000Z",
      }),
      run({
        id: "hangaritas-run",
        brand_name: "Hangaritas",
        seed_missing_reason: null,
        status: "complete",
        evidence_count: 19,
        updated_at: "2026-07-30T09:00:00.000Z",
      }),
    ];

    renderStatus("  HANGARITAS  ");

    expect(
      await screen.findByText("Hangaritas: research is ready"),
    ).toBeTruthy();
    expect(screen.getByText("19 useful sources checked")).toBeTruthy();
    expect(screen.queryByText("Sea Moss Only: waiting to start")).toBeNull();
  });

  test("does not show another brand when the current brand has no run", async () => {
    runs = [
      run({
        brand_name: "Sea Moss Only",
        seed_missing_reason: null,
        status: "queued",
      }),
    ];

    const { queryClient } = renderStatus("Hangaritas");

    await waitFor(() => {
      expect(queryClient.getQueryState(["brand-research-runs"])?.status).toBe(
        "success",
      );
    });
    expect(screen.queryByText(/Research .* for Sea Moss Only/)).toBeNull();
  });
});
