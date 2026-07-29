import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

function productionSources(directory: string): string[] {
  const sources: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...productionSources(path));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      sources.push(path);
    }
  }
  return sources;
}

const FORBIDDEN_PATTERNS = [
  /from\s+["'][^"']*memory\/db/u,
  /from\s+["'][^"']*runtime\/assistant-event-hub/u,
  /from\s+["'][^"']*runtime\/assistant-scope/u,
  /from\s+["'][^"']*util\/platform/u,
  /from\s+["']bun:sqlite["']/u,
  /\bDAEMON_INTERNAL_ASSISTANT_ID\b/u,
  /\bWORKLIN_PLATFORM_ASSISTANT_ID\b/u,
  /\bprocess\.chdir\s*\(/u,
] as const;

describe("concurrent runtime boundary", () => {
  test("does not import process-global tenant state or local SQLite", () => {
    const violations: string[] = [];
    for (const path of productionSources(import.meta.dir)) {
      const source = readFileSync(path, "utf8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(source)) {
          violations.push(`${path}: ${pattern.source}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
