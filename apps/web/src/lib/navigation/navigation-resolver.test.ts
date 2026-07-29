import { describe, expect, test } from "bun:test";

import {
  resolveLoginReturnTo,
  resolveNavigation,
  type NavigationDecision,
  type NavigationState,
} from "./navigation-resolver";

const base: NavigationState = {
  isLocalMode: false,
  isGatewayAuth: false,
  hasAssistants: true,
  sessionSettled: true,
  isAuthenticated: true,
  platformSession: "present",
  onboardingCompleted: true,
};

function state(overrides: Partial<NavigationState> = {}): NavigationState {
  return { ...base, ...overrides };
}

const ALLOW: NavigationDecision = { action: "allow" };
const WAIT: NavigationDecision = { action: "wait" };

describe("resolveNavigation", () => {
  describe("route guard", () => {
    const guard = (current: NavigationState, pathname = "/assistant") =>
      resolveNavigation(current, { kind: "route-guard", pathname });

    test("waits for session resolution and protects signed-out routes", () => {
      expect(guard(state({ sessionSettled: false }))).toEqual(WAIT);
      expect(guard(state({ isAuthenticated: false }))).toEqual({
        action: "redirect",
        to: "/account/login?returnTo=%2Fassistant",
      });
    });

    test("routes every incomplete platform account to prechat even when a default assistant exists", () => {
      expect(
        guard(state({ onboardingCompleted: false, hasAssistants: true })),
      ).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/prechat",
      });
      expect(
        guard(state({ onboardingCompleted: false, hasAssistants: false })),
      ).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/prechat",
      });
    });

    test("allows incomplete accounts to continue prechat", () => {
      expect(
        guard(
          state({ onboardingCompleted: false }),
          "/assistant/onboarding/prechat",
        ),
      ).toEqual(ALLOW);
    });

    test("keeps completed accounts out of prechat unless previewing", () => {
      expect(guard(state(), "/assistant/onboarding/prechat")).toEqual({
        action: "redirect",
        to: "/assistant",
      });
      expect(
        guard(state(), "/assistant/onboarding/prechat?preview=true"),
      ).toEqual(ALLOW);
    });

    test("legacy legal routes redirect without rendering legal UI", () => {
      expect(
        guard(
          state({ onboardingCompleted: false }),
          "/assistant/onboarding/privacy",
        ),
      ).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/prechat",
      });
      expect(guard(state(), "/assistant/review-terms")).toEqual({
        action: "redirect",
        to: "/assistant",
      });
    });

    test("allows an incomplete account with an allocated assistant to resume hatching", () => {
      expect(
        guard(
          state({ onboardingCompleted: false }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual(ALLOW);
      expect(
        guard(
          state({ onboardingCompleted: false, hasAssistants: false }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/prechat",
      });
    });

    test("completed platform accounts without an assistant go to hatching", () => {
      expect(guard(state({ hasAssistants: false }))).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/hatching",
      });
    });

    test("preserves local setup routing", () => {
      expect(
        guard(
          state({
            isLocalMode: true,
            isAuthenticated: false,
            hasAssistants: false,
          }),
        ),
      ).toEqual({ action: "redirect", to: "/assistant/welcome" });
      expect(
        guard(
          state({ isLocalMode: true, hasAssistants: false }),
          "/assistant/select-assistant",
        ),
      ).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/hosting",
      });
    });

    test("gateway auth bypasses platform onboarding", () => {
      expect(
        guard(
          state({
            isGatewayAuth: true,
            isAuthenticated: false,
            onboardingCompleted: false,
          }),
        ),
      ).toEqual(ALLOW);
    });
  });

  describe("onboarding intercept", () => {
    const intercept = (current: NavigationState, intendedDestination: string) =>
      resolveNavigation(current, {
        kind: "onboarding-intercept",
        intendedDestination,
      });

    test("redirects incomplete platform accounts and allows completed accounts", () => {
      expect(
        intercept(state({ onboardingCompleted: false }), "/assistant"),
      ).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/prechat",
      });
      expect(intercept(state(), "/assistant")).toEqual(ALLOW);
    });

    test("allows destinations outside the assistant", () => {
      expect(
        intercept(state({ onboardingCompleted: false }), "/account/login"),
      ).toEqual(ALLOW);
    });
  });

  describe("hatch gate", () => {
    const hatch = (current: NavigationState) =>
      resolveNavigation(current, { kind: "hatch-gate" });

    test("requires authentication and an allocated assistant before incomplete onboarding can hatch", () => {
      expect(hatch(state({ sessionSettled: false }))).toEqual(WAIT);
      expect(
        hatch(state({ isAuthenticated: false, isLocalMode: false })),
      ).toEqual({ action: "redirect", to: "/account/login" });
      expect(
        hatch(state({ onboardingCompleted: false, hasAssistants: false })),
      ).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/prechat",
      });
      expect(hatch(state({ onboardingCompleted: false }))).toEqual(ALLOW);
      expect(hatch(state())).toEqual(ALLOW);
    });
  });

  describe("post-auth and post-retire", () => {
    test("signup enters prechat and login keeps its safe return path", () => {
      expect(
        resolveNavigation(base, {
          kind: "post-auth",
          authIntent: "signup",
          returnTo: "/assistant/home",
          fallback: "/assistant",
        }),
      ).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/prechat",
      });
      expect(
        resolveNavigation(base, {
          kind: "post-auth",
          authIntent: "login",
          returnTo: "/assistant/home",
          fallback: "/assistant",
        }),
      ).toEqual({
        action: "redirect",
        to: "/assistant/home",
      });
    });

    test("completed platform users who retire their last assistant can hatch another", () => {
      expect(
        resolveNavigation(state({ hasAssistants: false }), {
          kind: "post-retire",
        }),
      ).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/hatching",
      });
    });
  });

  describe("login return path", () => {
    test("preserves the local welcome and assistant picker behavior", () => {
      expect(
        resolveLoginReturnTo(
          state({ hasAssistants: true }),
          "/assistant/welcome",
        ),
      ).toBe("/assistant/select-assistant");
      expect(
        resolveLoginReturnTo(
          state({ hasAssistants: false }),
          "/assistant/welcome",
        ),
      ).toBe("/assistant/onboarding/hosting");
    });
  });
});
