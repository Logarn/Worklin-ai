import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const checkpointStore = new Map<string, string>();

mock.module("../memory/checkpoints.js", () => ({
  deleteMemoryCheckpoint: (key: string) => checkpointStore.delete(key),
  getMemoryCheckpoint: (key: string) => checkpointStore.get(key) ?? null,
  setMemoryCheckpoint: (key: string, value: string) => {
    checkpointStore.set(key, value);
  },
}));

const { getCachedHomeGreeting, setCachedHomeGreeting } =
  await import("./home-greeting-cache.js");
const { advanceIdentityChangeEpoch, getIdentityChangeEpoch } =
  await import("../workspace/identity-change-invalidation.js");

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
let workspaceDir = "";

beforeEach(() => {
  workspaceDir = realpathSync(
    mkdtempSync(join(tmpdir(), "home-greeting-cache-test-")),
  );
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  writeFileSync(join(workspaceDir, "IDENTITY.md"), "identity");
  writeFileSync(join(workspaceDir, "SOUL.md"), "soul");
  checkpointStore.clear();
});

afterEach(() => {
  checkpointStore.clear();
  rmSync(workspaceDir, { recursive: true, force: true });
  if (originalWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  }
});

describe("home greeting cache identity epoch", () => {
  test("does not cache a generation completed after identity invalidation", () => {
    const generationEpoch = getIdentityChangeEpoch();
    advanceIdentityChangeEpoch();

    expect(setCachedHomeGreeting("stale greeting", generationEpoch)).toBe(
      false,
    );
    expect(getCachedHomeGreeting()).toBeNull();
    expect(checkpointStore.size).toBe(0);
  });
});
