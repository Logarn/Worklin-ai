import { describe, expect, test } from "bun:test";

describe("gateway /readyz diagnostic logging", () => {
  test("logs upstream failure details for Railway readiness triage", async () => {
    const src = await Bun.file(new URL("../index.ts", import.meta.url)).text();

    expect(src).toContain(
      "Gateway readiness probe: assistant /readyz returned a non-OK status",
    );
    expect(src).toContain(
      "Gateway readiness probe: assistant /readyz was unreachable",
    );
    expect(src).toContain("assistantRuntimeBaseUrl");
    expect(src).toContain("upstreamStatus");
  });
});
