import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { bundledToolRegistry } from "./bundled-tool-registry.js";

describe("bundled tool registry", () => {
  test("registers every Worklin retention skill executor", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          "bundled-skills",
          "worklin-retention",
          "TOOLS.json",
        ),
        "utf8",
      ),
    ) as {
      tools: Array<{ name: string; executor: string }>;
    };

    for (const tool of manifest.tools) {
      const key = `worklin-retention:${tool.executor}`;
      expect(bundledToolRegistry.has(key), tool.name).toBe(true);
    }
  });
});
