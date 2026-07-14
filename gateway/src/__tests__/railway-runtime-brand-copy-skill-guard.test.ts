import { describe, expect, test } from "bun:test";

describe("Railway runtime brand-copy skill packaging", () => {
  test("includes the production brand-copy skill in the Docker context", async () => {
    const dockerignore = await Bun.file(
      new URL("../../../.dockerignore", import.meta.url),
    ).text();
    const dockerfile = await Bun.file(
      new URL("../../../runtime/Dockerfile", import.meta.url),
    ).text();

    expect(dockerignore).toContain("!skills/write-brand-copy/**");
    expect(dockerfile).toContain("COPY skills ./skills");
  });
});
