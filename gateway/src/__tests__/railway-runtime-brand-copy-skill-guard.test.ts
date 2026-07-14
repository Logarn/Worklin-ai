import { describe, expect, test } from "bun:test";

describe("Railway runtime brand-copy skill packaging", () => {
  test("installs the production brand-copy skill in the bundled catalog", async () => {
    const dockerignore = await Bun.file(
      new URL("../../../.dockerignore", import.meta.url),
    ).text();
    const dockerfile = await Bun.file(
      new URL("../../../runtime/Dockerfile", import.meta.url),
    ).text();

    expect(dockerignore).toContain("!skills/**");
    expect(dockerfile).toContain("COPY skills ./skills");
    expect(dockerfile).toContain(
      "ENV VELLUM_FIRST_PARTY_SKILLS_DIR=/app/skills",
    );
  });
});
