import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const getAllauthByClientV1AuthSessionMock = mock(() =>
  Promise.resolve({
    data: undefined,
    error: undefined,
    response: {
      status: 401,
      headers: new Headers({
        "X-CSRFToken": "cross-origin-csrf-token",
      }),
    },
  }),
);

mock.module("@/generated/auth/sdk.gen", () => ({
  getAllauthByClientV1AuthSession: getAllauthByClientV1AuthSessionMock,
}));

mock.module("@/lib/auth/gateway-session", () => ({
  isGatewayAuthMode: () => false,
}));

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => false,
}));

const { ensureCsrfCookie, getCsrfToken } = await import("@/lib/auth/csrf");

function clearCsrfCookie(): void {
  document.cookie = "csrftoken=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  document.cookie =
    "__Secure-csrftoken=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; secure";
}

describe("csrf bootstrap", () => {
  beforeEach(() => {
    clearCsrfCookie();
    getAllauthByClientV1AuthSessionMock.mockClear();
  });

  afterEach(() => {
    clearCsrfCookie();
  });

  test("persists an exposed CSRF token for cross-origin web auth", async () => {
    await ensureCsrfCookie();

    expect(getAllauthByClientV1AuthSessionMock).toHaveBeenCalledTimes(1);
    expect(getCsrfToken()).toBe("cross-origin-csrf-token");
  });

  test("skips bootstrap when a readable CSRF cookie already exists", async () => {
    document.cookie = "csrftoken=existing-token; path=/";

    await ensureCsrfCookie();

    expect(getAllauthByClientV1AuthSessionMock).not.toHaveBeenCalled();
    expect(getCsrfToken()).toBe("existing-token");
  });
});
