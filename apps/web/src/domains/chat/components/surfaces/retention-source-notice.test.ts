import { describe, expect, test } from "bun:test";

import { getRetentionSourceNotice } from "./retention-source-notice";

describe("getRetentionSourceNotice", () => {
  test("blocks unsupported source modes and requires live regeneration", () => {
    const notice = getRetentionSourceNotice("sample");

    expect(notice).toEqual({
      title: "Blocked artifact: live data required.",
      body: "This artifact was not produced from an approved live-data source. It must be regenerated after current Shopify and Klaviyo data are available.",
      tone: "blocked",
    });
    expect(notice?.body).not.toContain("may have used");
    expect(notice?.body).not.toContain("fixture");
  });

  test("keeps partial live inventory explicit without suggesting sample data", () => {
    const notice = getRetentionSourceNotice("klaviyo_inventory");

    expect(notice?.title).toBe(
      "Partial live audit: Klaviyo inventory only.",
    );
    expect(notice?.body).toContain("live read-only Klaviyo");
    expect(notice?.body).toContain("full commerce audit remains blocked");
    expect(notice?.body).not.toContain("fixture");
  });

  test("does not warn for the full live source mode", () => {
    expect(getRetentionSourceNotice("live_readonly")).toBeNull();
  });
});
