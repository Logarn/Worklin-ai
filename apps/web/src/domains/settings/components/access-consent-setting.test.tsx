import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { ApiError } from "@/utils/api-errors";

const getConsentMock = mock(async (_assistantId: string) => ({
  access_consented: false,
  can_update: true,
}));
const updateConsentMock = mock(
  async (_assistantId: string, accessConsented: boolean) => ({
    access_consented: accessConsented,
    can_update: true,
  }),
);
const toastSuccessMock = mock((_message: string) => {});
const toastErrorMock = mock((_message: string) => {});

mock.module("@/domains/settings/api/assistant-access-consent", () => ({
  getAssistantAccessConsent: getConsentMock,
  updateAssistantAccessConsent: updateConsentMock,
}));

mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => "full",
  useActiveAssistantIsPlatformHosted: () => true,
  useActiveAssistantLifecycleIsLoading: () => false,
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => true,
}));

mock.module("@vellumai/design-library/components/toggle", () => ({
  Toggle: ({
    checked,
    disabled,
    onChange,
  }: {
    checked: boolean;
    disabled?: boolean;
    onChange: () => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-label="Admin access consent"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
    />
  ),
}));

mock.module("@vellumai/design-library/components/notice", () => ({
  Notice: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
  },
}));

const { AccessConsentSetting } =
  await import("@/domains/settings/components/access-consent-setting");

function renderSetting() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AccessConsentSetting />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

beforeEach(() => {
  getConsentMock.mockClear();
  updateConsentMock.mockClear();
  toastSuccessMock.mockClear();
  toastErrorMock.mockClear();
  getConsentMock.mockImplementation(async () => ({
    access_consented: false,
    can_update: true,
  }));
  updateConsentMock.mockImplementation(
    async (_assistantId: string, accessConsented: boolean) => ({
      access_consented: accessConsented,
      can_update: true,
    }),
  );
  useResolvedAssistantsStore.setState({
    activeAssistantId: "assistant-1",
  });
});

afterEach(() => {
  cleanup();
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

describe("AccessConsentSetting", () => {
  test("loads and updates consent for the selected assistant id", async () => {
    const view = renderSetting();
    const consentSwitch = await view.findByRole("switch", {
      name: "Admin access consent",
    });

    await waitFor(() =>
      expect(getConsentMock).toHaveBeenCalledWith("assistant-1"),
    );
    expect(consentSwitch.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(consentSwitch);

    await waitFor(() =>
      expect(updateConsentMock).toHaveBeenCalledWith("assistant-1", true),
    );
    await waitFor(() =>
      expect(consentSwitch.getAttribute("aria-checked")).toBe("true"),
    );
    expect(toastSuccessMock).toHaveBeenCalledWith("Admin data access enabled.");
  });

  test("shows a clear unavailable error and can retry the read", async () => {
    getConsentMock.mockImplementation(async () => {
      throw new ApiError(404, "Assistant not found.");
    });
    const view = renderSetting();

    expect((await view.findByRole("alert")).textContent).toContain(
      "This setting is not available for the selected assistant.",
    );
    expect((view.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);

    getConsentMock.mockImplementation(async () => ({
      access_consented: true,
      can_update: true,
    }));
    fireEvent.click(view.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect((view.getByRole("switch") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(view.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  test("keeps the confirmed value and explains a failed update", async () => {
    updateConsentMock.mockImplementation(async () => {
      throw new ApiError(500, "Internal server error.");
    });
    const view = renderSetting();
    const consentSwitch = await view.findByRole("switch");
    await waitFor(() =>
      expect((consentSwitch as HTMLButtonElement).disabled).toBe(false),
    );

    fireEvent.click(consentSwitch);

    expect((await view.findByRole("alert")).textContent).toContain(
      "Could not save this setting. Your previous choice is still active.",
    );
    expect(consentSwitch.getAttribute("aria-checked")).toBe("false");
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Could not save this setting. Your previous choice is still active.",
    );
  });

  test("keeps an in-flight update in the original assistant cache", async () => {
    let resolveUpdate:
      | ((value: { access_consented: boolean; can_update: boolean }) => void)
      | undefined;
    updateConsentMock.mockImplementation(
      () =>
        new Promise<{ access_consented: boolean; can_update: boolean }>(
          (resolve) => {
            resolveUpdate = resolve;
          },
        ),
    );
    const view = renderSetting();
    const consentSwitch = await view.findByRole("switch");
    await waitFor(() =>
      expect((consentSwitch as HTMLButtonElement).disabled).toBe(false),
    );

    fireEvent.click(consentSwitch);
    await waitFor(() =>
      expect(updateConsentMock).toHaveBeenCalledWith("assistant-1", true),
    );

    act(() => {
      useResolvedAssistantsStore.setState({
        activeAssistantId: "assistant-2",
      });
    });
    await waitFor(() =>
      expect(getConsentMock).toHaveBeenCalledWith("assistant-2"),
    );

    await act(async () => {
      resolveUpdate?.({ access_consented: true, can_update: true });
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(consentSwitch.getAttribute("aria-checked")).toBe("false"),
    );
    expect(
      view.queryClient.getQueryData<{
        access_consented: boolean;
        can_update: boolean;
      }>(["assistant-access-consent", "assistant-1"]),
    ).toEqual({ access_consented: true, can_update: true });
    expect(
      view.queryClient.getQueryData<{
        access_consented: boolean;
        can_update: boolean;
      }>(["assistant-access-consent", "assistant-2"]),
    ).toEqual({ access_consented: false, can_update: true });
  });

  test("renders collaborator access as read-only", async () => {
    getConsentMock.mockImplementation(async () => ({
      access_consented: true,
      can_update: false,
    }));
    const view = renderSetting();

    const consentSwitch = await view.findByRole("switch");
    await waitFor(() =>
      expect((consentSwitch as HTMLButtonElement).disabled).toBe(true),
    );
    expect(consentSwitch.getAttribute("aria-checked")).toBe("true");
    expect(
      view.getByText(
        "Only the assistant owner or a workspace admin can change this setting.",
      ),
    ).toBeTruthy();

    fireEvent.click(consentSwitch);
    expect(updateConsentMock).not.toHaveBeenCalled();
  });
});
