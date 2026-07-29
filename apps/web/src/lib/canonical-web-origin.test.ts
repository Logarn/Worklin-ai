import { describe, expect, test } from "bun:test";

import {
  CANONICAL_WORKLIN_WEB_ORIGIN,
  resolveCanonicalWorklinWebUrl,
} from "@/lib/canonical-web-origin";

describe("canonical Worklin web origin", () => {
  test("keeps the canonical production address unchanged", () => {
    expect(
      resolveCanonicalWorklinWebUrl(
        `${CANONICAL_WORKLIN_WEB_ORIGIN}/account/login?returnTo=%2Fassistant`,
      ),
    ).toBeNull();
  });

  test("redirects the legacy production address", () => {
    expect(
      resolveCanonicalWorklinWebUrl(
        "https://ai-retention-marketer.vercel.app/assistant/work?type=copy#august",
      ),
    ).toBe(
      `${CANONICAL_WORKLIN_WEB_ORIGIN}/assistant/work?type=copy#august`,
    );
  });

  test("redirects generated production deployment addresses", () => {
    expect(
      resolveCanonicalWorklinWebUrl(
        "https://worklin-example-team.vercel.app/account/login?returnTo=%2Fassistant",
      ),
    ).toBe(
      `${CANONICAL_WORKLIN_WEB_ORIGIN}/account/login?returnTo=%2Fassistant`,
    );
  });

  test("redirects generated branch preview addresses", () => {
    expect(
      resolveCanonicalWorklinWebUrl(
        "https://worklin-ai-git-feature-example-team.vercel.app/assistant",
      ),
    ).toBe(`${CANONICAL_WORKLIN_WEB_ORIGIN}/assistant`);
  });

  test("does not redirect local development", () => {
    expect(
      resolveCanonicalWorklinWebUrl("http://127.0.0.1:5177/assistant"),
    ).toBeNull();
  });

  test("does not redirect unrelated hosted applications", () => {
    expect(
      resolveCanonicalWorklinWebUrl(
        "https://example-product.vercel.app/account/login",
      ),
    ).toBeNull();
  });
});
