/**
 * Unit tests for identity field parsing and template placeholder filtering.
 *
 * Validates that parseIdentityFields correctly extracts real values from
 * IDENTITY.md content while treating template placeholders (e.g.
 * `_(not yet chosen)_`) as empty/unset.
 */

import { describe, expect, test } from "bun:test";

import {
  isTemplatePlaceholder,
  parseIdentityFields,
  updateIdentityFields,
} from "../daemon/handlers/identity.js";

// ---------------------------------------------------------------------------
// isTemplatePlaceholder
// ---------------------------------------------------------------------------

describe("isTemplatePlaceholder", () => {
  test("returns true for _(not yet chosen)_", () => {
    expect(isTemplatePlaceholder("_(not yet chosen)_")).toBe(true);
  });

  test("returns true for _(not yet established)_", () => {
    expect(isTemplatePlaceholder("_(not yet established)_")).toBe(true);
  });

  test("returns true for any value matching _(…)_ pattern", () => {
    expect(isTemplatePlaceholder("_(something else)_")).toBe(true);
  });

  test("returns false for normal values", () => {
    expect(isTemplatePlaceholder("Your helpful coding assistant")).toBe(false);
    expect(isTemplatePlaceholder("Jarvis")).toBe(false);
    expect(isTemplatePlaceholder("")).toBe(false);
  });

  test("returns false for partial matches", () => {
    expect(isTemplatePlaceholder("_(incomplete")).toBe(false);
    expect(isTemplatePlaceholder("incomplete)_")).toBe(false);
    expect(isTemplatePlaceholder("_(")).toBe(false);
    expect(isTemplatePlaceholder(")_")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseIdentityFields — placeholder filtering
// ---------------------------------------------------------------------------

describe("parseIdentityFields", () => {
  test("returns empty strings for all template placeholder values", () => {
    const content = [
      "- **Name:** _(not yet chosen)_",
      "- **Role:** _(not yet established)_",
      "- **Personality:** _(not yet chosen)_",
      "- **Emoji:** _(not yet chosen)_",
      "- **Home:** _(not yet chosen)_",
    ].join("\n");

    const fields = parseIdentityFields(content);
    expect(fields.name).toBe("");
    expect(fields.role).toBe("");
    expect(fields.personality).toBe("");
    expect(fields.emoji).toBe("");
    expect(fields.home).toBe("");
  });

  test("preserves real user-provided values", () => {
    const content = [
      "- **Name:** Jarvis",
      "- **Role:** Coding assistant",
      "- **Personality:** Friendly and helpful",
      "- **Emoji:** 🤖",
      "- **Home:** ~/projects",
    ].join("\n");

    const fields = parseIdentityFields(content);
    expect(fields.name).toBe("Jarvis");
    expect(fields.role).toBe("Coding assistant");
    expect(fields.personality).toBe("Friendly and helpful");
    expect(fields.emoji).toBe("🤖");
    expect(fields.home).toBe("~/projects");
  });

  test("preserves markdown-like punctuation inside a field value", () => {
    const content = "- **Role:** Growth lead: **email and lifecycle**";

    expect(parseIdentityFields(content).role).toBe(
      "Growth lead: **email and lifecycle**",
    );
  });

  test("reads only top metadata outside fenced examples and later sections", () => {
    const content = [
      "# IDENTITY.md",
      "",
      "- **Name:** Canonical name",
      "- **Role:** Canonical role",
      "```md",
      "- **Name:** Fenced name",
      "- **Role:** Fenced role",
      "```",
      "",
      "## History",
      "- **Name:** Historical name",
      "- **Role:** Historical role",
    ].join("\n");

    expect(parseIdentityFields(content)).toMatchObject({
      name: "Canonical name",
      role: "Canonical role",
    });
  });

  test("ignores multiline HTML comments before the canonical metadata block", () => {
    const content = [
      "# IDENTITY.md",
      "",
      "<!--",
      "- **Name:** Comment example",
      "- **Role:** Comment role",
      "-->",
      "",
      "- **Name:** Canonical name",
      "- **Role:** Canonical role",
    ].join("\n");

    expect(parseIdentityFields(content)).toMatchObject({
      name: "Canonical name",
      role: "Canonical role",
    });
  });

  test("does not scan past prose, indented code, or a non-closing fence", () => {
    const prose = [
      "# IDENTITY.md",
      "Example metadata:",
      "- **Name:** Prose example",
    ].join("\n");
    const indentedCode = [
      "# IDENTITY.md",
      "    - **Name:** Code example",
      "- **Role:** Row after code",
    ].join("\n");
    const nonClosingFence = [
      "# IDENTITY.md",
      "- **Name:** Canonical name",
      "````markdown this fence never closes",
      "- **Role:** Fenced role",
    ].join("\n");

    expect(parseIdentityFields(prose).name).toBe("");
    expect(parseIdentityFields(indentedCode)).toMatchObject({
      name: "",
      role: "",
    });
    expect(parseIdentityFields(nonClosingFence)).toMatchObject({
      name: "Canonical name",
      role: "",
    });
  });

  test("treats an indented HTML-looking block as code, not metadata trivia", () => {
    const content = [
      "# IDENTITY.md",
      "    <!-- example -->",
      "- **Name:** Row after indented code",
    ].join("\n");

    expect(parseIdentityFields(content).name).toBe("");
  });

  test("does not scan into a non-closing multiline HTML comment", () => {
    const content = [
      "# IDENTITY.md",
      "<!-- unfinished example",
      "- **Name:** Comment example",
    ].join("\n");

    expect(parseIdentityFields(content).name).toBe("");
  });

  test("prefers canonical Personality over the legacy Vibe alias", () => {
    expect(
      parseIdentityFields(
        [
          "- **Personality:** Canonical personality",
          "- **Vibe:** Legacy value after canonical",
        ].join("\n"),
      ).personality,
    ).toBe("Canonical personality");
    expect(
      parseIdentityFields(
        [
          "- **Vibe:** Legacy value before canonical",
          "- **Personality:** Canonical personality",
        ].join("\n"),
      ).personality,
    ).toBe("Canonical personality");
    expect(parseIdentityFields("- **Vibe:** Legacy fallback").personality).toBe(
      "Legacy fallback",
    );
  });

  test("handles a mix of real and placeholder values", () => {
    const content = [
      "- **Name:** Jarvis",
      "- **Role:** _(not yet established)_",
      "- **Personality:** Friendly",
      "- **Emoji:** _(not yet chosen)_",
      "- **Home:** ~/dev",
    ].join("\n");

    const fields = parseIdentityFields(content);
    expect(fields.name).toBe("Jarvis");
    expect(fields.role).toBe("");
    expect(fields.personality).toBe("Friendly");
    expect(fields.emoji).toBe("");
    expect(fields.home).toBe("~/dev");
  });

  test("returns role: '' when IDENTITY.md contains placeholder role", () => {
    const content = "- **Role:** _(not yet established)_";
    const fields = parseIdentityFields(content);
    expect(fields.role).toBe("");
  });

  test("returns name: '' when IDENTITY.md contains placeholder name", () => {
    const content = "- **Name:** _(not yet chosen)_";
    const fields = parseIdentityFields(content);
    expect(fields.name).toBe("");
  });

  test('parses role: "Coding assistant" for real values', () => {
    const content = "- **Role:** Coding assistant";
    const fields = parseIdentityFields(content);
    expect(fields.role).toBe("Coding assistant");
  });

  test("returns empty strings when content has no identity fields", () => {
    const fields = parseIdentityFields("# Some other content\nHello world");
    expect(fields.name).toBe("");
    expect(fields.role).toBe("");
    expect(fields.personality).toBe("");
    expect(fields.emoji).toBe("");
    expect(fields.home).toBe("");
  });
});

describe("updateIdentityFields", () => {
  test("replaces placeholders while preserving unrelated identity sections", () => {
    const content = [
      "# IDENTITY.md",
      "",
      "- **Name:** _(not yet chosen)_",
      "- **Role:** _(not yet established)_",
      "",
      "## Avatar",
      "Keep this content.",
      "",
    ].join("\n");

    const updated = updateIdentityFields(content, {
      name: "North Star",
      role: "Lifecycle marketing partner",
    });

    expect(updated).toContain("- **Name:** North Star");
    expect(updated).toContain("- **Role:** Lifecycle marketing partner");
    expect(updated).toContain("## Avatar\nKeep this content.");
    expect(updated.endsWith("\n")).toBe(true);
  });

  test("inserts a missing field at the canonical block boundary", () => {
    const updated = updateIdentityFields(
      "# IDENTITY.md\n\n- **Name:** North Star\n\n## Avatar\nKeep this content.",
      { personality: "Clear, curious, and candid" },
    );

    expect(updated).toContain(
      "- **Name:** North Star\n\n- **Personality:** Clear, curious, and candid\n\n## Avatar",
    );
  });

  test("normalizes duplicate rows so a stale value cannot win parsing", () => {
    const updated = updateIdentityFields(
      [
        "# IDENTITY.md",
        "- **Role:** Old role",
        "- **Role:** Stale duplicate",
      ].join("\n"),
      { role: "Product strategy partner" },
    );

    expect(updated.match(/Product strategy partner/g)).toHaveLength(2);
    expect(parseIdentityFields(updated).role).toBe("Product strategy partner");
  });

  test("does not rewrite fenced examples or metadata-like rows in later sections", () => {
    const updated = updateIdentityFields(
      [
        "# IDENTITY.md",
        "- **Role:** Canonical role",
        "```md",
        "- **Role:** Fenced role",
        "```",
        "## History",
        "- **Role:** Historical role",
      ].join("\n"),
      { role: "Updated canonical role" },
    );

    expect(updated).toContain("- **Role:** Updated canonical role");
    expect(updated).toContain("```md\n- **Role:** Fenced role\n```");
    expect(updated).toContain("## History\n- **Role:** Historical role");
  });

  test("canonicalizes a top-level Vibe alias without touching later aliases", () => {
    const updated = updateIdentityFields(
      [
        "# IDENTITY.md",
        "- **Vibe:** Legacy top value",
        "## Examples",
        "- **Vibe:** Example value",
      ].join("\n"),
      { personality: "Clear and candid" },
    );

    expect(updated).toContain("- **Personality:** Clear and candid");
    expect(updated).toContain("## Examples\n- **Vibe:** Example value");
    expect(parseIdentityFields(updated).personality).toBe("Clear and candid");
  });

  test("inserts missing fields before comments and indented code", () => {
    const content = [
      "# IDENTITY.md",
      "",
      "- **Name:** Canonical name",
      "<!--",
      "- **Role:** Comment example",
      "-->",
      "    - **Role:** Indented code example",
    ].join("\n");

    const updated = updateIdentityFields(content, {
      role: "Canonical role",
    });

    expect(updated.indexOf("- **Role:** Canonical role")).toBeLessThan(
      updated.indexOf("<!--"),
    );
    expect(updated).toContain("- **Role:** Comment example");
    expect(updated).toContain("    - **Role:** Indented code example");
    expect(parseIdentityFields(updated).role).toBe("Canonical role");
  });

  test("updates canonical metadata after a multiline comment without rewriting the comment", () => {
    const content = [
      "# IDENTITY.md",
      "<!--",
      "- **Role:** Comment example",
      "-->",
      "- **Role:** Canonical role",
    ].join("\n");

    const updated = updateIdentityFields(content, { role: "Updated role" });

    expect(updated).toContain("<!--\n- **Role:** Comment example\n-->");
    expect(updated).toContain("-->\n- **Role:** Updated role");
    expect(parseIdentityFields(updated).role).toBe("Updated role");
  });

  test("creates the canonical block before prose instead of rewriting its example", () => {
    const content = [
      "# IDENTITY.md",
      "",
      "For example, identity metadata can look like this:",
      "- **Name:** Example only",
    ].join("\n");

    const updated = updateIdentityFields(content, { name: "North Star" });

    expect(updated.indexOf("- **Name:** North Star")).toBeLessThan(
      updated.indexOf("For example"),
    );
    expect(updated).toContain("- **Name:** Example only");
    expect(parseIdentityFields(updated).name).toBe("North Star");
  });

  test("inserts before a malformed non-closing fence without touching its rows", () => {
    const content = [
      "# IDENTITY.md",
      "",
      "- **Name:** North Star",
      "```markdown this fence never closes",
      "- **Role:** Fenced example",
    ].join("\n");

    const updated = updateIdentityFields(content, {
      role: "Lifecycle partner",
    });

    expect(updated.indexOf("- **Role:** Lifecycle partner")).toBeLessThan(
      updated.indexOf("```markdown"),
    );
    expect(updated).toContain("- **Role:** Fenced example");
    expect(parseIdentityFields(updated).role).toBe("Lifecycle partner");
  });
});
