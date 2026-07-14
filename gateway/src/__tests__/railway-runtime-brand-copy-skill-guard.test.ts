import { describe, expect, test } from "bun:test";

describe("Railway runtime brand-copy skill packaging", () => {
  test("installs the production brand-copy skill in the bundled catalog", async () => {
    const dockerignore = await Bun.file(
      new URL("../../../.dockerignore", import.meta.url),
    ).text();
    const dockerfile = await Bun.file(
      new URL("../../../runtime/Dockerfile", import.meta.url),
    ).text();

    // The runtime now bundles every first-party skill. A broad allow-list is
    // stronger than a one-off exception for the copy skill.
    expect(dockerignore).toContain("!skills/**");
    expect(dockerfile).toContain("COPY skills ./skills");
    expect(dockerfile).toContain(
      "ENV VELLUM_FIRST_PARTY_SKILLS_DIR=/app/skills",
    );
  });
});
