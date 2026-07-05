import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const sourcePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../conversation-process.ts",
);

function extractFunctionSource(name: string): string {
  const source = readFileSync(sourcePath, "utf8");
  const start = source.indexOf(`async function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf("\n) {", start);
  expect(bodyStart).toBeGreaterThanOrEqual(0);

  let depth = 0;
  let bodyStarted = false;
  for (let index = bodyStart + 3; index < source.length; index++) {
    const char = source[index];
    if (char === "{") {
      depth++;
      bodyStarted = true;
    } else if (char === "}") {
      depth--;
      if (bodyStarted && depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Could not extract ${name}`);
}

describe("retention Klaviyo connection surface lifecycle", () => {
  test("opening the standalone Klaviyo form is non-blocking", () => {
    const helperSource = extractFunctionSource(
      "showRetentionKlaviyoConnectionCard",
    );

    expect(helperSource).toContain("void showStandaloneSurface(");
    expect(helperSource).not.toContain("await showStandaloneSurface(");
  });
});
