import { describe, expect, test } from "bun:test";

describe("gateway config port fallback", () => {
  test("loadConfig considers Railway PORT when GATEWAY_PORT is unset", async () => {
    const src = await Bun.file(new URL("../config.ts", import.meta.url)).text();

    expect(src).toContain(
      'const portRaw = process.env.GATEWAY_PORT || process.env.PORT || "7830";',
    );
  });
});
