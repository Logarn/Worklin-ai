import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { updateIdentityAvatarSection } from "./identity-avatar.js";

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
let workspaceDir = "";

beforeEach(() => {
  workspaceDir = realpathSync(
    mkdtempSync(join(tmpdir(), "identity-avatar-test-")),
  );
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
  if (originalWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  }
});

describe("updateIdentityAvatarSection", () => {
  test("replaces a CRLF section once while preserving BOM and mode", async () => {
    const identityPath = join(workspaceDir, "IDENTITY.md");
    const original =
      "\uFEFF# IDENTITY.md\r\n\r\n- **Name:** Example Assistant\r\n\r\n" +
      "## Avatar\r\nOld avatar description.\r\n\r\n" +
      "## Notes\r\nKeep this section.\r\n";
    writeFileSync(identityPath, original, "utf-8");
    chmodSync(identityPath, 0o640);

    await updateIdentityAvatarSection("New portrait.\nSecond line.");
    await updateIdentityAvatarSection("Final portrait.");

    const bytes = readFileSync(identityPath);
    const content = bytes.toString("utf-8");
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(content.match(/^## Avatar\r?$/gm)).toHaveLength(1);
    expect(content).toContain(
      "## Avatar\r\nFinal portrait.\r\n\r\n## Notes\r\n",
    );
    expect(content).not.toContain("Old avatar description.");
    expect(content).not.toMatch(/(^|[^\r])\n/);
    expect(statSync(identityPath).mode & 0o777).toBe(0o640);
  });
});
