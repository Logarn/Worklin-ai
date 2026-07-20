import { describe, expect, test } from "bun:test";
import { matchRoutes } from "react-router";

import { routeTree } from "@/routes";

// Walk the matched route chain for `path` and report whether `AccountLayout`
// is one of its layout components. Matching runs against the raw `routeTree`
// (not the constructed `router`) because `createBrowserRouter` consumes the
// `Component` field, leaving nothing to inspect.
function isUnderAccountLayout(path: string): boolean {
  const matches = matchRoutes(routeTree as never, path) ?? [];
  return matches.some(
    (m) =>
      (m.route as { Component?: { name?: string } }).Component?.name ===
      "AccountLayout",
  );
}

interface RawRoute {
  path?: string;
  children?: RawRoute[];
  Component?: { name?: string };
  lazy?: unknown;
}

function findRouteByPath(
  routes: RawRoute[],
  path: string,
): RawRoute | undefined {
  for (const route of routes) {
    if (route.path === path) return route;
    const child = findRouteByPath(route.children ?? [], path);
    if (child) return child;
  }
  return undefined;
}

describe("account route compact-window grouping", () => {
  // The auth screens that render in the main window opt into the compact
  // (440×630) window via AccountLayout's sizing hook.
  test.each([
    "/account",
    "/account/login",
    "/account/signup",
    "/account/provider/callback",
    "/account/provider/signup",
    "/account/password/reset",
    "/account/password/reset/key/abc123",
  ])("%s is sized by AccountLayout", (path) => {
    expect(isUnderAccountLayout(path)).toBe(true);
  });

  // The OAuth completion / loopback pages render inside a popup child window
  // (or are transient redirects). They must stay OUT of AccountLayout — the
  // resize IPC targets the main window, so sizing from a popup would shrink
  // the wrong window and persist `onboardingActive`.
  test.each([
    "/account/oauth/popup-complete",
    "/account/oauth/complete",
    "/account/oauth/desktop-complete",
    "/account/platform-callback",
  ])("%s is NOT sized by AccountLayout", (path) => {
    expect(isUnderAccountLayout(path)).toBe(false);
  });
});

describe("Work routes", () => {
  test("keeps the app detail route available with the main application shell", () => {
    const route = findRouteByPath(
      routeTree as RawRoute[],
      "work/brands/:brandId/artifacts/apps/:appId",
    );

    expect(route?.Component?.name).toBe("WorkAppPage");
    expect(route?.lazy).toBeUndefined();
  });
});
