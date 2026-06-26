import { describe, expect, test } from "bun:test";

describe("Railway runtime observability wiring", () => {
  test("runtime bundle enables assistant stdout logs in container deployments", async () => {
    const entrypoint = await Bun.file(
      new URL("../../../runtime/entrypoint.sh", import.meta.url),
    ).text();
    const dockerfile = await Bun.file(
      new URL("../../../runtime/Dockerfile", import.meta.url),
    ).text();

    expect(entrypoint).toContain(': "${DEBUG_STDOUT_LOGS:=1}"');
    expect(entrypoint).toContain("export DEBUG_STDOUT_LOGS");
    expect(dockerfile).toContain("ENV DEBUG_STDOUT_LOGS=1");
  });
});
