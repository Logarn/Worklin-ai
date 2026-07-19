import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const hardNavigateMock = mock((_to: string) => {});
const saveConsentMock = mock(async (_args: unknown) => {});
const navigateMock = mock((_to: string) => {});
const handleLogoutMock = mock(async (_navigate: unknown) => {});

let searchParamsValue = new URLSearchParams();

mock.module("react-router", () => ({
  useSearchParams: () => [searchParamsValue, mock(() => {})],
  useNavigate: () => navigateMock,
}));

mock.module("@/lib/auth/hard-navigate", () => ({
  hardNavigate: hardNavigateMock,
}));

mock.module("@/lib/auth/handle-logout", () => ({
  handleLogout: handleLogoutMock,
}));

mock.module("@/utils/onboarding-cleanup", () => ({
  saveConsent: saveConsentMock,
}));

mock.module("@/domains/onboarding/prefs", () => ({
  readAiDataConsent: () => true,
  readSelectedVersion: () => null,
  readShareAnalytics: () => false,
  readTosAccepted: () => true,
  useAiDataConsent: () => [true, mock(() => {})],
  useShareAnalytics: () => [false, mock(() => {})],
  useShareDiagnostics: () => [false, mock(() => {})],
  useTosAccepted: () => [true, mock(() => {})],
  writeSelectedVersion: mock(() => {}),
}));

mock.module("@/runtime/is-electron", () => ({ isElectron: () => false }));
mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    use: {
      platformSession: () => "present",
      sessionStatus: () => "authenticated",
      user: () => ({ id: "user-1" }),
      logout: () => mock(async () => {}),
    },
  },
  useHasPlatformSession: () => true,
  useIsAuthenticated: () => true,
  useIsSessionInitializing: () => false,
}));

mock.module("@/domains/onboarding/components/onboarding-layout", () => ({
  OnboardingLayout: ({ children }: { children: React.ReactNode }) => children,
}));
mock.module("@vellumai/design-library/components/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
mock.module("@vellumai/design-library/components/checkbox", () => ({
  Checkbox: ({ label }: { label: React.ReactNode }) => <label>{label}</label>,
}));

const { ReviewTermsScreen } = await import(
  "@/domains/onboarding/pages/review-terms-screen"
);

describe("ReviewTermsScreen", () => {
  beforeEach(() => {
    searchParamsValue = new URLSearchParams(
      "returnTo=%2Fassistant%2Fconversations%2Fdraft-123",
    );
    hardNavigateMock.mockClear();
    saveConsentMock.mockClear();
    navigateMock.mockClear();
    handleLogoutMock.mockClear();
  });

  afterEach(cleanup);

  test("persists consent before hard navigation rebuilds assistant state", async () => {
    render(<ReviewTermsScreen />);

    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() => {
      expect(saveConsentMock).toHaveBeenCalledTimes(1);
      expect(hardNavigateMock).toHaveBeenCalledWith(
        "/assistant/conversations/draft-123",
      );
    });
  });

  test("does not navigate while the server consent write is pending", async () => {
    let resolveConsent: (() => void) | undefined;
    saveConsentMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveConsent = resolve;
        }),
    );
    render(<ReviewTermsScreen />);

    fireEvent.click(screen.getByText("Continue"));

    expect(screen.getByText("Saving…")).toBeTruthy();
    expect(hardNavigateMock).not.toHaveBeenCalled();

    await act(async () => resolveConsent?.());
    await waitFor(() => {
      expect(hardNavigateMock).toHaveBeenCalledWith(
        "/assistant/conversations/draft-123",
      );
    });
  });

  test("uses the complete hosted logout flow", async () => {
    render(<ReviewTermsScreen />);

    fireEvent.click(screen.getByText("Log out"));

    await waitFor(() => {
      expect(handleLogoutMock).toHaveBeenCalledWith(navigateMock);
    });
  });
});
