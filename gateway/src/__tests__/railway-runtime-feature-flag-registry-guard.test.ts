import { describe, expect, test } from "bun:test";

describe("Railway runtime feature-flag registry packaging", () => {
  test("bundles the canonical registry for the assistant and gateway", async () => {
    const dockerignore = await Bun.file(
      new URL("../../../.dockerignore", import.meta.url),
    ).text();
    const dockerfile = await Bun.file(
      new URL("../../../runtime/Dockerfile", import.meta.url),
    ).text();

    expect(dockerignore).toContain(
      "!meta/feature-flags/feature-flag-registry.json",
    );
    expect(dockerfile).toContain(
      "COPY meta/feature-flags/feature-flag-registry.json ./assistant/src/config/feature-flag-registry.json",
    );
    expect(dockerfile).toContain(
      "COPY meta/feature-flags/feature-flag-registry.json ./gateway/src/feature-flag-registry.json",
    );
  });
});
