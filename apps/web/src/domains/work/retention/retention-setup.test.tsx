import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";

const activateMutate = mock((_input: unknown, _options?: unknown) => {});
const pauseMutate = mock((_input: unknown, _options?: unknown) => {});
const importMutate = mock((_input: unknown, _options?: unknown) => {});
let klaviyoConnected = false;

mock.module("@/lib/retention/use-retention-status", () => ({
  useRetentionStatus: () => ({
    data: {
      integrations: klaviyoConnected
        ? [{ provider: "klaviyo", status: "connected" }]
        : [],
    },
    isPending: false,
    isError: false,
  }),
}));

mock.module("./use-retention-setup", () => ({
  useRetentionSetup: () => ({
    programs: {
      data: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          brandId: "22222222-2222-4222-8222-222222222222",
          type: "re_engagement",
          name: "Re-engagement",
          status: "draft",
          policyVersion: "v1",
          policyApprovalSha256: null,
          approvedBy: null,
          approvedAt: null,
          updatedAt: "2026-07-28T10:00:00.000Z",
        },
      ],
      isPending: false,
      isError: false,
      refetch: mock(async () => {}),
    },
    imports: {
      data: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          brandId: "22222222-2222-4222-8222-222222222222",
          integrationId: "44444444-4444-4444-8444-444444444444",
          provider: "shopify",
          status: "preview",
          importedCount: 0,
          rejectedCount: 0,
          approvedAt: null,
          startedAt: null,
          completedAt: null,
          lastErrorCode: null,
          updatedAt: "2026-07-28T10:00:00.000Z",
          hasCheckpoint: false,
        },
      ],
      isPending: false,
      isError: false,
      refetch: mock(async () => {}),
    },
  }),
  useRetentionProgramApprovalPreview: () => ({
    data: {
      programId: "11111111-1111-4111-8111-111111111111",
      status: "draft",
      snapshotSha256: "a".repeat(64),
      material: {
        orgId: "55555555-5555-4555-8555-555555555555",
        programId: "11111111-1111-4111-8111-111111111111",
        program: "re_engagement",
        name: "Re-engagement",
        policyVersion: "v1",
        policy: { objective: "Earn a useful return visit." },
      },
    },
    isPending: false,
  }),
  useActivateRetentionProgram: () => ({
    mutate: activateMutate,
    isPending: false,
    isError: false,
  }),
  usePauseRetentionProgram: () => ({
    mutate: pauseMutate,
    isPending: false,
  }),
  useApproveRetentionImport: () => ({
    mutate: importMutate,
    isPending: false,
    isSuccess: false,
  }),
}));

const { RetentionSetup } = await import("./retention-setup");

function CurrentLocation() {
  const location = useLocation();
  return (
    <output data-testid="current-location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function renderSetup() {
  return render(
    <MemoryRouter>
      <RetentionSetup assistantId="assistant-1" />
      <CurrentLocation />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  activateMutate.mockClear();
  pauseMutate.mockClear();
  importMutate.mockClear();
  klaviyoConnected = false;
});

describe("RetentionSetup", () => {
  test("reviews a frozen policy and confirms a read-only import separately", () => {
    renderSetup();

    expect(screen.getByText("Re-engagement")).toBeTruthy();
    expect(screen.getByText("Shopify history")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("Earn a useful return visit.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Activate program" }));
    expect(activateMutate).toHaveBeenCalledWith(
      {
        programId: "11111111-1111-4111-8111-111111111111",
        expectedPolicySha256: "a".repeat(64),
      },
      expect.any(Object),
    );

    fireEvent.click(screen.getByRole("button", { name: "Start import" }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(
        "Worklin will read approved history into this workspace. It will not change Shopify or Klaviyo.",
      ),
    ).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Start import" }),
    );
    expect(importMutate).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      expect.any(Object),
    );
  });

  test("opens connection management in Integrations", () => {
    const { container } = renderSetup();

    expect(screen.getByText("Klaviyo not connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect Klaviyo" }));
    expect(screen.getByTestId("current-location").textContent).toBe(
      "/assistant/settings/integrations?provider=klaviyo",
    );
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  test("shows the shared Klaviyo connection status", () => {
    klaviyoConnected = true;
    renderSetup();

    expect(screen.getByText("Klaviyo connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View integration" }));
    expect(screen.getByTestId("current-location").textContent).toBe(
      "/assistant/settings/integrations?provider=klaviyo",
    );
  });
});
