import { describe, expect, test } from "bun:test";

import {
  normalizeHostedProxyPath,
  resolveAuthActionUrl,
  resolvePlatformActionUrl,
} from "@/lib/api-origins";

describe("api-origins", () => {
  test("normalizes same-origin proxy paths without changing other paths", () => {
    const origin = "https://worklin.example";

    expect(normalizeHostedProxyPath("/v1/assistants/", origin)).toBe(
      "/v1/assistants",
    );
    expect(
      normalizeHostedProxyPath("/_allauth/browser/v1/config/?x=1", origin),
    ).toBe("/_allauth/browser/v1/config?x=1");
    expect(normalizeHostedProxyPath("/callback/?code=abc", origin)).toBe(
      "/callback?code=abc",
    );
    expect(
      normalizeHostedProxyPath("/assistant/onboarding/hatching/", origin),
    ).toBe("/assistant/onboarding/hatching/");
  });

  test("does not normalize a cross-origin request", () => {
    expect(
      normalizeHostedProxyPath(
        "https://api.worklin.example/v1/assistants/",
        "https://worklin.example",
      ),
    ).toBe("https://api.worklin.example/v1/assistants/");
  });

  test("resolves action paths against the active API origin", () => {
    const expected = new URL(
      "/v1/telemetry/ingest/",
      window.location.origin,
    ).toString();

    expect(resolvePlatformActionUrl("/v1/telemetry/ingest/")).toBe(expected);
    expect(resolveAuthActionUrl("/_allauth/browser/v1/config/")).toBe(
      new URL("/_allauth/browser/v1/config/", window.location.origin).toString(),
    );
  });
});
