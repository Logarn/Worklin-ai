import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const hardNavigateMock = mock((_to: string) => {});
const saveConsentMock = mock((_args: unknown) => {});

let searchParamsValue = new URLSearchParams();

mock.module("react-router", () => ({
  useSearchParams: () => [searchParamsValue, mock(() => {})],
}));

mock.module("@/lib/auth/hard-navigate", () => ({
  hardNavigate: hardNavigateMock,
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
  });

  afterEach(cleanup);

  test("continues with a hard navigation so assistant state is rebuilt", () => {
    render(<ReviewTermsScreen />);

    fireEvent.click(screen.getByText("Continue"));

    expect(saveConsentMock).toHaveBeenCalledTimes(1);
    expect(hardNavigateMock).toHaveBeenCalledWith(
      "/assistant/conversations/draft-123",
    );
  });
});
