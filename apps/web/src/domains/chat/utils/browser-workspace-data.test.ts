import { describe, expect, it } from "bun:test";

import {
  isSafeBrowserScreenshot,
  isSafeBrowserUrl,
  normalizeBrowserWorkspaceData,
} from "./browser-workspace-data";

describe("browser workspace data", () => {
  it("accepts web URLs and raster image previews", () => {
    expect(isSafeBrowserUrl("https://example.com/path")).toBe(true);
    expect(isSafeBrowserScreenshot("data:image/jpeg;base64,YWJjZA==")).toBe(
      true,
    );

    expect(
      normalizeBrowserWorkspaceData({
        url: "https://example.com/path",
        title: "Example",
        screenshotDataUrl: "data:image/png;base64,YWJjZA==",
        status: "working",
        updatedAt: 123,
        activity: [],
      }),
    ).toMatchObject({
      url: "https://example.com/path",
      title: "Example",
      screenshotDataUrl: "data:image/png;base64,YWJjZA==",
      status: "working",
      updatedAt: 123,
    });
  });

  it("drops unsafe URLs and executable image payloads", () => {
    expect(isSafeBrowserUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeBrowserScreenshot("data:image/svg+xml;base64,PHN2Zz4=")).toBe(
      false,
    );

    const normalized = normalizeBrowserWorkspaceData({
      url: "javascript:alert(1)",
      screenshotDataUrl: "data:image/svg+xml;base64,PHN2Zz4=",
      status: "unexpected",
      activity: [],
    });

    expect(normalized.url).toBeUndefined();
    expect(normalized.screenshotDataUrl).toBeUndefined();
    expect(normalized.status).toBe("ready");
  });

  it("keeps only the newest twenty valid activity entries", () => {
    const normalized = normalizeBrowserWorkspaceData({
      activity: [
        { label: "invalid" },
        ...Array.from({ length: 24 }, (_, index) => ({
          id: `item-${index}`,
          label: `Step ${index}`,
          status: index === 23 ? "error" : "completed",
          timestamp: index,
        })),
      ],
    });

    expect(normalized.activity).toHaveLength(20);
    expect(normalized.activity[0]?.id).toBe("item-4");
    expect(normalized.activity.at(-1)?.status).toBe("error");
  });
});
