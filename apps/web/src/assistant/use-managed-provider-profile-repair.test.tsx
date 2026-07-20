import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

let unavailable = false;
const repairUnavailableManagedProfile = mock(async () => ({
  repaired: true,
}));

mock.module("@/assistant/managed-inference-availability", () => ({
  useManagedInferenceAvailability: () => ({
    available: !unavailable,
    unavailable,
    isLoading: false,
  }),
}));

mock.module("@/assistant/provider-profile-repair", () => ({
  repairUnavailableManagedProfile,
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

const { useManagedProviderProfileRepair } = await import(
  "@/assistant/use-managed-provider-profile-repair"
);

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  unavailable = false;
  repairUnavailableManagedProfile.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("useManagedProviderProfileRepair", () => {
  test("does not change profiles when managed platform auth is available", async () => {
    renderHook(
      () => useManagedProviderProfileRepair("asst-1", true),
      { wrapper },
    );

    await Promise.resolve();
    expect(repairUnavailableManagedProfile).not.toHaveBeenCalled();
  });

  test("attempts one conservative repair after explicit unavailability", async () => {
    unavailable = true;
    const { rerender } = renderHook(
      () => useManagedProviderProfileRepair("asst-1", true),
      { wrapper },
    );

    await waitFor(() => {
      expect(repairUnavailableManagedProfile).toHaveBeenCalledTimes(1);
    });

    rerender();
    expect(repairUnavailableManagedProfile).toHaveBeenCalledTimes(1);
  });
});
