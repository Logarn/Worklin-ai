import { describe, expect, test } from "bun:test";

describe("Railway runtime port wiring", () => {
  test("runtime bundle defers gateway port selection to Railway PORT", async () => {
    const entrypoint = await Bun.file(
      new URL("../../../runtime/entrypoint.sh", import.meta.url),
    ).text();
    const dockerfile = await Bun.file(
      new URL("../../../runtime/Dockerfile", import.meta.url),
    ).text();

    expect(entrypoint).toContain(': "${PORT:=7830}"');
    expect(entrypoint).toContain(': "${GATEWAY_PORT:=${PORT}}"');
    expect(dockerfile).not.toContain("ENV GATEWAY_PORT=7830");
    expect(dockerfile).not.toContain(
      "ENV GATEWAY_INTERNAL_URL=http://127.0.0.1:7830",
    );
  });
});
