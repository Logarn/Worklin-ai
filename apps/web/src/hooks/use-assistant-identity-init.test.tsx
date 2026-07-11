import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";

import { ASSISTANT_NAME_KEY } from "@/domains/onboarding/prechat";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const fetchAssistantIdentityMock = mock(async () => null);

mock.module("@/assistant/identity", () => ({
  fetchAssistantIdentity: fetchAssistantIdentityMock,
}));

const { useAssistantIdentityInit } = await import(
  "@/hooks/use-assistant-identity-init"
);

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

beforeEach(() => {
  sessionStorage.clear();
  useAssistantIdentityStore.getState().clearIdentity();
  fetchAssistantIdentityMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("useAssistantIdentityInit", () => {
  test("applies optimistic onboarding names once per assistant id", async () => {
    sessionStorage.setItem(ASSISTANT_NAME_KEY, "First");
    const view = renderHook(
      ({ assistantId }: { assistantId: string }) =>
        useAssistantIdentityInit({
          assistantId,
          assistantStateKind: "active",
        }),
      {
        initialProps: { assistantId: "asst-1" },
        wrapper: makeWrapper(),
      },
    );

    await waitFor(() =>
      expect(useAssistantIdentityStore.getState().name).toBe("First"),
    );

    sessionStorage.setItem(ASSISTANT_NAME_KEY, "Second");
    view.rerender({ assistantId: "asst-2" });

    await waitFor(() =>
      expect(useAssistantIdentityStore.getState().name).toBe("Second"),
    );
  });
});
