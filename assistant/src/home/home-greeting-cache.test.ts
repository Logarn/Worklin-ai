import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const checkpointStore = new Map<string, string>();
let onCheckpointSet: (() => void) | null = null;

mock.module("../memory/checkpoints.js", () => ({
  deleteMemoryCheckpoint: (key: string) => checkpointStore.delete(key),
  getMemoryCheckpoint: (key: string) => checkpointStore.get(key) ?? null,
  setMemoryCheckpoint: (key: string, value: string) => {
    checkpointStore.set(key, value);
    const callback = onCheckpointSet;
    onCheckpointSet = null;
    callback?.();
  },
}));

const { getCachedHomeGreeting, setCachedHomeGreeting } =
  await import("./home-greeting-cache.js");
const {
  _resetIdentityFreshnessForTests,
  advanceIdentityChangeEpoch,
  getIdentityChangeEpoch,
} = await import("../workspace/identity-change-invalidation.js");

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
let workspaceDir = "";

beforeEach(() => {
  workspaceDir = realpathSync(
    mkdtempSync(join(tmpdir(), "home-greeting-cache-test-")),
  );
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  writeFileSync(join(workspaceDir, "IDENTITY.md"), "identity");
  writeFileSync(join(workspaceDir, "SOUL.md"), "soul");
  _resetIdentityFreshnessForTests();
  onCheckpointSet = null;
  checkpointStore.clear();
  onCheckpointSet = null;
});

afterEach(() => {
  checkpointStore.clear();
  _resetIdentityFreshnessForTests();
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

  test("rejects an in-flight generation after an external SOUL change", () => {
    const generationEpoch = getIdentityChangeEpoch();

    writeFileSync(join(workspaceDir, "SOUL.md"), "changed soul");

    expect(setCachedHomeGreeting("stale greeting", generationEpoch)).toBe(
      false,
    );
    expect(getCachedHomeGreeting()).toBeNull();
    expect(checkpointStore.size).toBe(0);
  });

  test("removes a cache entry when identity changes during checkpoint writes", () => {
    const generationEpoch = getIdentityChangeEpoch();
    onCheckpointSet = () => {
      writeFileSync(join(workspaceDir, "IDENTITY.md"), "changed identity");
    };

    expect(setCachedHomeGreeting("stale greeting", generationEpoch)).toBe(
      false,
    );
    expect(checkpointStore.size).toBe(0);
  });
});
