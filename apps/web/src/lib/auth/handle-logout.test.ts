import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { NavigateFunction } from "react-router";

let localMode = false;
let electron = false;
let activeAssistant: unknown = null;
let activeAssistantIsLocal = false;

const logoutMock = mock(async () => {});
const navigateMock = mock((_to: string) => {});
const hardNavigateMock = mock((_to: string) => {});
const setMenuPlatformSessionMock = mock(async (_present: boolean) => {});
const setAuthStateMock = mock((_state: unknown) => {});

mock.module("@/domains/onboarding/gate", () => ({
  getOnboardingEntrypoint: () => "/assistant/onboarding/hosting",
}));

mock.module("@/lib/auth/hard-navigate", () => ({
  hardNavigate: hardNavigateMock,
}));

mock.module("@/lib/local-mode", () => ({
  getActiveAssistant: () => activeAssistant,
  isLocalAssistant: () => activeAssistantIsLocal,
  isLocalMode: () => localMode,
}));

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => electron,
}));

mock.module("@/runtime/menu", () => ({
  setMenuPlatformSession: setMenuPlatformSessionMock,
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    getState: () => ({ logout: logoutMock }),
    setState: setAuthStateMock,
  },
}));

const { handleLogout } = await import("@/lib/auth/handle-logout");

beforeEach(() => {
  localMode = false;
  electron = false;
  activeAssistant = null;
  activeAssistantIsLocal = false;
  logoutMock.mockClear();
  navigateMock.mockClear();
  hardNavigateMock.mockClear();
  setMenuPlatformSessionMock.mockClear();
  setAuthStateMock.mockClear();
});

describe("handleLogout", () => {
  test("hosted browser logout continues through the Auth0 logout endpoint", async () => {
    await handleLogout(navigateMock as unknown as NavigateFunction);

    expect(logoutMock).toHaveBeenCalledTimes(1);
    expect(hardNavigateMock).toHaveBeenCalledWith("/logout");
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test("hosted browser reaches Auth0 logout even when local cleanup rejects", async () => {
    logoutMock.mockImplementationOnce(async () => {
      throw new Error("cleanup failed");
    });

    await expect(
      handleLogout(navigateMock as unknown as NavigateFunction),
    ).resolves.toBeUndefined();

    expect(hardNavigateMock).toHaveBeenCalledWith("/logout");
  });

  test("Electron keeps the existing in-app login destination", async () => {
    electron = true;

    await handleLogout(navigateMock as unknown as NavigateFunction);

    expect(logoutMock).toHaveBeenCalledTimes(1);
    expect(hardNavigateMock).toHaveBeenCalledWith("/account/login");
    expect(hardNavigateMock).not.toHaveBeenCalledWith("/logout");
  });

  test("a local assistant remains usable while its platform session is hidden", async () => {
    localMode = true;
    activeAssistant = { assistantId: "assistant-local" };
    activeAssistantIsLocal = true;

    await handleLogout(navigateMock as unknown as NavigateFunction);

    expect(setMenuPlatformSessionMock).toHaveBeenCalledWith(false);
    expect(setAuthStateMock).toHaveBeenCalledWith({
      platformSession: "absent",
    });
    expect(logoutMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(hardNavigateMock).not.toHaveBeenCalled();
  });

  test("local managed-assistant logout returns to local onboarding", async () => {
    localMode = true;
    activeAssistant = { assistantId: "assistant-managed" };

    await handleLogout(navigateMock as unknown as NavigateFunction);

    expect(setMenuPlatformSessionMock).toHaveBeenCalledWith(false);
    expect(logoutMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith("/assistant/onboarding/hosting");
    expect(hardNavigateMock).not.toHaveBeenCalled();
  });
});
