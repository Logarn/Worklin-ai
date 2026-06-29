import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";

let currentReturnTo: string | null = "/assistant";
let isAuthenticated = false;

const navigateMock = mock((_to: string, _opts?: { replace?: boolean }) => {});

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => {
    const params = new URLSearchParams();
    if (currentReturnTo) {
      params.set("returnTo", currentReturnTo);
    }
    return [params];
  },
}));

mock.module("@/components/native-splash", () => ({
  NativeSplash: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

mock.module("@/domains/account/components/login-shell", () => ({
  DarkLoginShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LoginCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LoginErrorText: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

mock.module("@/domains/account/components/platform-login-buttons", () => ({
  PlatformLoginButtons: () => <div>platform-login-buttons</div>,
}));

mock.module("@/runtime/native-auth", () => ({
  startAuthFlow: mock(async () => {}),
  startNativeLogin: mock(async () => {}),
  useIsNativePlatform: () => false,
}));

mock.module("@/stores/auth-store", () => ({
  useIsAuthenticated: () => isAuthenticated,
}));

mock.module("@vellumai/design-library", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));

const { LoginPage } = await import("./login-page");

describe("LoginPage", () => {
  beforeEach(() => {
    currentReturnTo = "/assistant";
    isAuthenticated = false;
    navigateMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("renders the hosted login controls for an unauthenticated web session", () => {
    const { getByText } = render(<LoginPage />);

    expect(getByText("platform-login-buttons")).toBeTruthy();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test("redirects authenticated users away from /account/login", async () => {
    isAuthenticated = true;

    const { getByText } = render(<LoginPage />);

    expect(getByText("Redirecting you to Worklin...")).toBeTruthy();
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/assistant", { replace: true }),
    );
  });
});
