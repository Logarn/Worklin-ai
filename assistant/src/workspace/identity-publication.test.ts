import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

const publishedFields: Array<Record<string, string>> = [];
const syncedNames: string[] = [];

mock.module("../runtime/sync/resource-sync-events.js", () => ({
  publishIdentityChanged: (fields: Record<string, string>) => {
    publishedFields.push(fields);
  },
}));

mock.module("../platform/sync-identity.js", () => ({
  syncIdentityNameToPlatform: (name: string) => {
    syncedNames.push(name);
  },
}));

const { withCoordinatedIdentityPublication } =
  await import("./identity-publication.js");
const { _resetIdentityFreshnessForTests, getIdentityChangeEpoch } =
  await import("./identity-change-invalidation.js");
const { readHatchedAtSidecar } = await import("./hatched-date.js");

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
let workspaceDir = "";

beforeEach(() => {
  workspaceDir = realpathSync(
    mkdtempSync(join(tmpdir(), "identity-publication-test-")),
  );
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  writeFileSync(
    join(workspaceDir, "IDENTITY.md"),
    "# Identity\n\n- **Name:** Before\n",
  );
  writeFileSync(join(workspaceDir, "SOUL.md"), "Be kind.\n");
  publishedFields.length = 0;
  syncedNames.length = 0;
  _resetIdentityFreshnessForTests();
});

afterEach(() => {
  _resetIdentityFreshnessForTests();
  rmSync(workspaceDir, { recursive: true, force: true });
  if (originalWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  }
});

test("publishes a successful bulk identity replacement exactly once", async () => {
  const identityPath = join(workspaceDir, "IDENTITY.md");
  const replacementPath = join(workspaceDir, "replacement.md");
  const originalHatchedAt = statSync(identityPath).birthtime.toISOString();
  const beforeEpoch = getIdentityChangeEpoch();

  const result = await withCoordinatedIdentityPublication(async () => {
    writeFileSync(
      replacementPath,
      "# Identity\n\n- **Name:** Imported\n- **Role:** Operator\n",
    );
    renameSync(replacementPath, identityPath);
    return { ok: true as const };
  });

  expect(result.ok).toBe(true);
  expect(readHatchedAtSidecar()).toBe(originalHatchedAt);
  expect(getIdentityChangeEpoch()).toBe(beforeEpoch + 1);
  expect(publishedFields).toHaveLength(1);
  expect(publishedFields[0]).toMatchObject({
    name: "Imported",
    role: "Operator",
  });
  expect(syncedNames).toEqual(["Imported"]);
  expect(readFileSync(identityPath, "utf-8")).toContain("Name:** Imported");
});

test("does not publish a failed import result", async () => {
  const beforeEpoch = getIdentityChangeEpoch();

  await withCoordinatedIdentityPublication(() => ({ ok: false as const }), {
    didCommit: (result) => result.ok,
  });

  expect(getIdentityChangeEpoch()).toBe(beforeEpoch);
  expect(publishedFields).toHaveLength(0);
  expect(syncedNames).toHaveLength(0);
});
