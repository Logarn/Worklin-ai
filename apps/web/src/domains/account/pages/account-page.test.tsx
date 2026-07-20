import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";

const navigateMock = mock((_to: string) => {});
const handleLogoutMock = mock(async (_navigate: unknown) => {});

mock.module("react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => navigateMock,
}));

mock.module("@/components/account/account-form", () => ({
  AccountHeading: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

mock.module("@/components/account/account-shell", () => ({
  AccountShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

mock.module("@/lib/auth/handle-logout", () => ({
  handleLogout: handleLogoutMock,
}));

mock.module("@/runtime/native-auth", () => ({
  startAuthFlow: async () => {},
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    use: {
      user: () => ({ id: "user-1", username: "Customer" }),
    },
  },
  useIsAuthenticated: () => true,
  useIsSessionInitializing: () => false,
}));

const { AccountPage } = await import("@/domains/account/pages/account-page");

beforeEach(() => {
  navigateMock.mockClear();
  handleLogoutMock.mockClear();
});

afterEach(cleanup);

describe("AccountPage", () => {
  test("sign out uses the complete hosted logout flow", async () => {
    render(<AccountPage />);

    fireEvent.click(screen.getByText("Sign out"));

    await waitFor(() => {
      expect(handleLogoutMock).toHaveBeenCalledWith(navigateMock);
    });
  });
});
