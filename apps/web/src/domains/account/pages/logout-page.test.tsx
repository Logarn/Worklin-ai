import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";

let searchParamsValue = new URLSearchParams();

const logoutMock = mock(async () => {});
const hardNavigateMock = mock((_to: string) => {});

mock.module("react-router", () => ({
  useSearchParams: () => [searchParamsValue],
}));

mock.module("@/components/account/account-form", () => ({
  AccountHeading: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

mock.module("@/components/account/account-shell", () => ({
  AccountShell: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

mock.module("@/lib/auth/hard-navigate", () => ({
  hardNavigate: hardNavigateMock,
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    use: {
      logout: () => logoutMock,
    },
  },
}));

const { LogoutPage } = await import("@/domains/account/pages/logout-page");

beforeEach(() => {
  searchParamsValue = new URLSearchParams();
  logoutMock.mockClear();
  hardNavigateMock.mockClear();
});

afterEach(cleanup);

describe("LogoutPage", () => {
  test("logs out once and exits to login without revisiting /logout", async () => {
    render(<LogoutPage />);

    await waitFor(() => {
      expect(logoutMock).toHaveBeenCalledTimes(1);
      expect(hardNavigateMock).toHaveBeenCalledWith("/account/login");
    });
    expect(hardNavigateMock).not.toHaveBeenCalledWith("/logout");
  });

  test("still exits to login when logout rejects", async () => {
    logoutMock.mockImplementationOnce(async () => {
      throw new Error("logout failed");
    });

    render(<LogoutPage />);

    await waitFor(() => {
      expect(hardNavigateMock).toHaveBeenCalledWith("/account/login");
    });
    expect(logoutMock).toHaveBeenCalledTimes(1);
    expect(hardNavigateMock).not.toHaveBeenCalledWith("/logout");
  });
});
