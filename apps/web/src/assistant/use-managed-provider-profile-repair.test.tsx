import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import { authInfoGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";

let unavailable = false;
const repairUnavailableManagedProfile = mock(async () => ({
  repaired: true,
}));

const { useManagedProviderProfileRepair } = await import(
  "@/assistant/use-managed-provider-profile-repair"
);

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    authInfoGetQueryKey({ path: { assistant_id: "asst-1" } }),
    {
      platformUrl: unavailable ? null : "https://platform.example.com",
      assistantId: "asst-1",
      organizationId: null,
      userId: null,
      authenticated: !unavailable,
    },
  );
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  unavailable = false;
  repairUnavailableManagedProfile.mockClear();
});

afterEach(() => {
  unavailable = false;
  cleanup();
});

describe("useManagedProviderProfileRepair", () => {
  test("does not change profiles when managed platform auth is available", async () => {
    renderHook(
      () =>
        useManagedProviderProfileRepair(
          "asst-1",
          true,
          repairUnavailableManagedProfile,
        ),
      { wrapper },
    );

    await Promise.resolve();
    expect(repairUnavailableManagedProfile).not.toHaveBeenCalled();
  });

  test("attempts one conservative repair after explicit unavailability", async () => {
    unavailable = true;
    const { rerender } = renderHook(
      () =>
        useManagedProviderProfileRepair(
          "asst-1",
          true,
          repairUnavailableManagedProfile,
        ),
      { wrapper },
    );

    await waitFor(() => {
      expect(repairUnavailableManagedProfile).toHaveBeenCalledTimes(1);
    });

    rerender();
    expect(repairUnavailableManagedProfile).toHaveBeenCalledTimes(1);
  });
});
