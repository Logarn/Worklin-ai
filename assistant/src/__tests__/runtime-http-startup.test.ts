import { describe, expect, test } from "bun:test";

import {
  RUNTIME_HTTP_LOOPBACK_FALLBACK_HOST,
  shouldRetryRuntimeHttpOnLoopback,
} from "../daemon/runtime-http-startup.js";

describe("runtime HTTP startup fallback", () => {
  test("retries non-loopback listen failures on loopback", () => {
    expect(RUNTIME_HTTP_LOOPBACK_FALLBACK_HOST).toBe("127.0.0.1");
    expect(
      shouldRetryRuntimeHttpOnLoopback("0.0.0.0", {
        syscall: "listen",
      }),
    ).toBe(true);
  });

  test("retries non-loopback bind errors identified by errno code", () => {
    expect(
      shouldRetryRuntimeHttpOnLoopback("192.168.1.10", {
        code: "EADDRNOTAVAIL",
      }),
    ).toBe(true);
  });

  test("does not retry loopback hosts", () => {
    expect(
      shouldRetryRuntimeHttpOnLoopback("127.0.0.1", {
        syscall: "listen",
      }),
    ).toBe(false);
    expect(
      shouldRetryRuntimeHttpOnLoopback("localhost", {
        code: "EADDRINUSE",
      }),
    ).toBe(false);
  });

  test("does not retry unrelated errors", () => {
    expect(
      shouldRetryRuntimeHttpOnLoopback("0.0.0.0", {
        code: "ENOENT",
      }),
    ).toBe(false);
    expect(shouldRetryRuntimeHttpOnLoopback("0.0.0.0", "boom")).toBe(false);
  });
});
