import { describe, expect, test } from "bun:test";

import { checkStorageReadiness } from "./storage-readiness.js";

describe("storage readiness", () => {
  test("reports ready when the probe succeeds", () => {
    expect(checkStorageReadiness(() => undefined)).toEqual({ ready: true });
  });

  test("reports an unavailable storage reason when the probe throws", () => {
    expect(
      checkStorageReadiness(() => {
        throw new Error("disk I/O error");
      }),
    ).toEqual({ ready: false, error: "disk I/O error" });
  });

  test("normalizes non-Error probe failures", () => {
    expect(
      checkStorageReadiness(() => {
        throw "read failed";
      }),
    ).toEqual({ ready: false, error: "read failed" });
  });
});
