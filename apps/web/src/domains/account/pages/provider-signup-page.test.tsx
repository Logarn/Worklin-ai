import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type ReactNode } from "react";

const navigateMock = mock((_to: string, _options?: { replace?: boolean }) => {});
const refreshSessionMock = mock(async () => {});
const getProviderSignupMock = mock(async () => ({
  ok: true as const,
  data: {
    user: {
      email: "marketer@example.com",
      username: "marketer",
      first_name: "Sample",
      last_name: "Marketer",
    },
  },
}));
const submitProviderSignupMock = mock(
  async (_identity: { email: string; username: string }) => ({
    ok: true as const,
  }),
);

mock.module("react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => navigateMock,
  useSearchParams: () => [new URLSearchParams()] as const,
}));

mock.module("@/components/account/account-form", () => ({
  AccountForm: ({ children }: { children: ReactNode }) => <form>{children}</form>,
  AccountHeading: ({
    title,
    subtitle,
  }: {
    title: string;
    subtitle: string;
  }) => (
    <div>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </div>
  ),
  AccountInput: () => <input />,
}));

mock.module("@/components/account/account-shell", () => ({
  AccountShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

mock.module("@/domains/account/components/personal-page-shell", () => ({
  PersonalPageShell: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
}));

mock.module("@/domains/account/login-flow", () => ({
  resolvePostAuthDestination: () => ({
    destination: "/assistant/onboarding",
    requiresFullPageNavigation: false,
  }),
  resolvePostLoginDestination: () => ({
    destination: "/assistant",
    requiresFullPageNavigation: false,
  }),
}));

mock.module("@/lib/auth/allauth-client", () => ({
  getProviderSignup: getProviderSignupMock,
  isConflict: () => false,
  submitProviderSignup: submitProviderSignupMock,
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    use: {
      refreshSession: () => refreshSessionMock,
    },
  },
}));

mock.module("@/stores/client-feature-flag-store", () => ({
  useClientFeatureFlagStore: {
    use: {
      stringFlags: () => ({
        experimentActivationFlow20260603: "personal-page",
      }),
    },
  },
}));

const { ProviderSignupPage } = await import("./provider-signup-page");

beforeEach(() => {
  navigateMock.mockClear();
  refreshSessionMock.mockClear();
  getProviderSignupMock.mockClear();
  submitProviderSignupMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("ProviderSignupPage personal-page flow", () => {
  test("completes provider signup without asking duplicate identity or role questions", async () => {
    render(<ProviderSignupPage />);

    await waitFor(() =>
      expect(submitProviderSignupMock).toHaveBeenCalledWith({
        email: "marketer@example.com",
        username: "marketer",
      }),
    );

    expect(screen.queryByText("Your role")).toBeNull();
    expect(screen.queryByPlaceholderText("First name")).toBeNull();
    expect(screen.queryByPlaceholderText("Last name")).toBeNull();
    expect(refreshSessionMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith("/assistant/onboarding");
  });
});
