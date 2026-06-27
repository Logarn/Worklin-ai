import { describe, expect, test } from "bun:test";

describe("Railway runtime port wiring", () => {
  test("runtime bundle keeps Railway PORT on the public control-plane and reserves 7830 for the private gateway", async () => {
    const entrypoint = await Bun.file(
      new URL("../../../runtime/entrypoint.sh", import.meta.url),
    ).text();
    const dockerfile = await Bun.file(
      new URL("../../../runtime/Dockerfile", import.meta.url),
    ).text();

    expect(entrypoint).toContain(': "${PORT:=8080}"');
    expect(entrypoint).toContain(': "${WORKLIN_CONTROL_PLANE_PORT:=${PORT}}"');
    expect(entrypoint).toContain(': "${GATEWAY_PORT:=7830}"');
    expect(dockerfile).not.toContain("ENV GATEWAY_PORT=7830");
    expect(dockerfile).not.toContain(
      "ENV GATEWAY_INTERNAL_URL=http://127.0.0.1:7830",
    );
  });
});
