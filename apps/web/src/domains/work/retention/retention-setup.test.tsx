import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

const activateMutate = mock((_input: unknown, _options?: unknown) => {});
const pauseMutate = mock((_input: unknown, _options?: unknown) => {});
const importMutate = mock((_input: unknown, _options?: unknown) => {});
let connectError: unknown = null;
const connectMutate = mock(
  (
    _input: unknown,
    options?: {
      onError?: (error: unknown) => void;
      onSettled?: () => void;
    },
  ) => {
    if (connectError) options?.onError?.(connectError);
    options?.onSettled?.();
  },
);

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
  useConnectKlaviyo: () => ({
    mutate: connectMutate,
    isPending: false,
    isSuccess: false,
  }),
}));

const { RetentionApiError } = await import("./retention-api");
const { RetentionSetup } = await import("./retention-setup");

afterEach(() => {
  cleanup();
  activateMutate.mockClear();
  pauseMutate.mockClear();
  importMutate.mockClear();
  connectMutate.mockClear();
  connectError = null;
});

describe("RetentionSetup", () => {
  test("reviews a frozen policy and confirms a read-only import separately", () => {
    render(<RetentionSetup assistantId="assistant-1" />);

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

  test("connects Klaviyo with approved properties and clears the key", () => {
    render(<RetentionSetup assistantId="assistant-1" />);

    fireEvent.change(screen.getByLabelText("Brand name"), {
      target: { value: "Example Brand" },
    });
    fireEvent.change(screen.getByLabelText("Website (optional)"), {
      target: { value: "drrachael.example" },
    });
    const keyInput = screen.getByLabelText(
      "Klaviyo private API key",
    ) as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "pk_private" } });
    fireEvent.change(screen.getByLabelText("Approved property 1"), {
      target: { value: "Lead Magnet" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    fireEvent.change(screen.getByLabelText("Approved property 2"), {
      target: { value: "Product Interest" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect securely" }));

    expect(connectMutate).toHaveBeenCalledWith(
      {
        brandName: "Example Brand",
        websiteUrl: "https://drrachael.example/",
        credential: "pk_private",
        propertyAllowlist: ["Lead Magnet", "Product Interest"],
      },
      expect.any(Object),
    );
    expect(keyInput.value).toBe("");
  });

  test("shows a useful rejected-key error without redisplaying the key", () => {
    connectError = new RetentionApiError(
      401,
      "provider response contained private detail",
      "klaviyo_credentials_rejected",
    );
    render(<RetentionSetup assistantId="assistant-1" />);

    fireEvent.change(screen.getByLabelText("Brand name"), {
      target: { value: "Example Brand" },
    });
    const keyInput = screen.getByLabelText(
      "Klaviyo private API key",
    ) as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "pk_rejected" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect securely" }));

    expect(
      screen.getByText(
        "Klaviyo rejected this private key. Check the key and try again.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("provider response contained private detail"),
    ).toBeNull();
    expect(screen.queryByText("pk_rejected")).toBeNull();
    expect(keyInput.value).toBe("");
  });

  test("explains when the Klaviyo key needs read permissions", () => {
    connectError = new RetentionApiError(
      403,
      "provider scope detail",
      "klaviyo_read_scope_required",
    );
    render(<RetentionSetup assistantId="assistant-1" />);

    fireEvent.change(screen.getByLabelText("Brand name"), {
      target: { value: "Example Brand" },
    });
    const keyInput = screen.getByLabelText(
      "Klaviyo private API key",
    ) as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "pk_needs_scope" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect securely" }));

    expect(
      screen.getByText(
        "This key is missing a required read permission. Update its Klaviyo access and try again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("provider scope detail")).toBeNull();
    expect(keyInput.value).toBe("");
  });
});
