import { describe, expect, test } from "bun:test";

describe("Railway runtime port wiring", () => {
  test("combined, isolated, and pooled runtime modes expose the correct process", async () => {
    const entrypoint = await Bun.file(
      new URL("../../../runtime/entrypoint.sh", import.meta.url),
    ).text();
    const dockerfile = await Bun.file(
      new URL("../../../runtime/Dockerfile", import.meta.url),
    ).text();

    expect(entrypoint).toContain(': "${PORT:=8080}"');
    expect(entrypoint).toContain(': "${WORKLIN_PUBLIC_EDGE_PORT:=${PORT}}"');
    expect(entrypoint).toContain(
      ': "${WORKLIN_CONTROL_PLANE_INTERNAL_PORT:=8082}"',
    );
    expect(entrypoint).toContain(
      ': "${WORKLIN_CONTROL_PLANE_PORT:=${WORKLIN_CONTROL_PLANE_INTERNAL_PORT}}"',
    );
    expect(entrypoint).toContain(': "${WORKLIN_RUNTIME_MODE:=combined}"');
    expect(entrypoint).toContain(': "${GATEWAY_PORT:=${PORT}}"');
    expect(entrypoint).toContain(': "${GATEWAY_PORT:=7830}"');
    expect(entrypoint).toContain(
      'if [[ "${WORKLIN_RUNTIME_MODE}" == "isolated" ||',
    );
    expect(entrypoint).toContain(
      '"${WORKLIN_RUNTIME_MODE}" == "pooled_worker"',
    );
    expect(entrypoint).toContain(
      'if [[ "${WORKLIN_RUNTIME_MODE}" == "combined" ]]; then',
    );
    expect(dockerfile).not.toContain("ENV GATEWAY_PORT=7830");
    expect(dockerfile).not.toContain(
      "ENV GATEWAY_INTERNAL_URL=http://127.0.0.1:7830",
    );
    expect(dockerfile).toContain("EXPOSE 8080");
  });
});
