/**
 * Unit tests for the empty-state greeting cache
 * (runtime/routes/empty-state-greeting-cache.ts).
 *
 * Validates TTL round-tripping, expiry, and the TTL=0 "always regenerate"
 * behavior that disables caching entirely.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — defined before importing the module under test
// ---------------------------------------------------------------------------

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

let cacheTtlMs = 4 * 60 * 60 * 1000;

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ ui: { emptyStateGreetingCacheTtlMs: cacheTtlMs } }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  getCachedEmptyStateGreeting,
  setCachedEmptyStateGreeting,
} from "../runtime/routes/empty-state-greeting-cache.js";
import {
  _resetIdentityFreshnessForTests,
  advanceIdentityChangeEpoch,
  getIdentityChangeEpoch,
} from "../workspace/identity-change-invalidation.js";

const TIMESTAMP_KEY = "empty_state:greeting:cached_at";

beforeEach(() => {
  cacheTtlMs = 4 * 60 * 60 * 1000;
  onCheckpointSet = null;
});

afterEach(() => {
  checkpointStore.clear();
  onCheckpointSet = null;
});

describe("empty-state greeting cache", () => {
  test("returns null when the cache is empty", () => {
    expect(getCachedEmptyStateGreeting()).toBeNull();
  });

  test("round-trips set then get within the TTL", () => {
    setCachedEmptyStateGreeting("hey there");
    expect(getCachedEmptyStateGreeting()).toBe("hey there");
  });

  test("returns null once the TTL is exceeded", () => {
    setCachedEmptyStateGreeting("stale");
    checkpointStore.set(
      TIMESTAMP_KEY,
      String(Date.now() - (4 * 60 + 1) * 60 * 1000),
    );
    expect(getCachedEmptyStateGreeting()).toBeNull();
  });

  test("returns the cached value just within the TTL", () => {
    setCachedEmptyStateGreeting("fresh enough");
    checkpointStore.set(
      TIMESTAMP_KEY,
      String(Date.now() - (3 * 60 + 59) * 60 * 1000),
    );
    expect(getCachedEmptyStateGreeting()).toBe("fresh enough");
  });

  test("TTL of 0 disables caching: writes are skipped and reads miss", () => {
    cacheTtlMs = 0;
    setCachedEmptyStateGreeting("should not persist");
    expect(checkpointStore.size).toBe(0);
    expect(getCachedEmptyStateGreeting()).toBeNull();
  });

  test("TTL of 0 ignores a value cached while caching was enabled", () => {
    setCachedEmptyStateGreeting("cached while on");
    cacheTtlMs = 0;
    expect(getCachedEmptyStateGreeting()).toBeNull();
  });

  test("rejects a generated greeting from an older identity epoch", () => {
    const generationEpoch = getIdentityChangeEpoch();
    expect(setCachedEmptyStateGreeting("old identity", generationEpoch)).toBe(
      true,
    );

    advanceIdentityChangeEpoch();

    expect(getCachedEmptyStateGreeting()).toBeNull();
    expect(setCachedEmptyStateGreeting("stale result", generationEpoch)).toBe(
      false,
    );
    expect(checkpointStore.size).toBe(0);
  });

  test("rejects an in-flight generation after an external identity change", () => {
    const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    const workspaceDir = realpathSync(
      mkdtempSync(join(tmpdir(), "empty-greeting-freshness-test-")),
    );
    process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
    writeFileSync(join(workspaceDir, "IDENTITY.md"), "identity-a");
    writeFileSync(join(workspaceDir, "SOUL.md"), "soul-a");
    _resetIdentityFreshnessForTests();

    try {
      const generationEpoch = getIdentityChangeEpoch();
      expect(setCachedEmptyStateGreeting("old identity", generationEpoch)).toBe(
        true,
      );

      writeFileSync(join(workspaceDir, "IDENTITY.md"), "identity-b");

      expect(setCachedEmptyStateGreeting("stale result", generationEpoch)).toBe(
        false,
      );
      expect(getCachedEmptyStateGreeting()).toBeNull();
    } finally {
      _resetIdentityFreshnessForTests();
      rmSync(workspaceDir, { recursive: true, force: true });
      if (originalWorkspaceDir === undefined) {
        delete process.env.VELLUM_WORKSPACE_DIR;
      } else {
        process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
      }
    }
  });

  test("removes a greeting when identity changes during checkpoint writes", () => {
    const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    const workspaceDir = realpathSync(
      mkdtempSync(join(tmpdir(), "empty-greeting-install-race-test-")),
    );
    process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
    writeFileSync(join(workspaceDir, "IDENTITY.md"), "identity-a");
    writeFileSync(join(workspaceDir, "SOUL.md"), "soul-a");
    _resetIdentityFreshnessForTests();

    try {
      const generationEpoch = getIdentityChangeEpoch();
      onCheckpointSet = () => {
        writeFileSync(join(workspaceDir, "SOUL.md"), "soul-b");
      };

      expect(setCachedEmptyStateGreeting("stale result", generationEpoch)).toBe(
        false,
      );
      expect(checkpointStore.size).toBe(0);
    } finally {
      _resetIdentityFreshnessForTests();
      rmSync(workspaceDir, { recursive: true, force: true });
      if (originalWorkspaceDir === undefined) {
        delete process.env.VELLUM_WORKSPACE_DIR;
      } else {
        process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
      }
    }
  });

  test("returns null when the timestamp checkpoint is missing", () => {
    checkpointStore.set("empty_state:greeting:text", "orphaned");
    expect(getCachedEmptyStateGreeting()).toBeNull();
  });
});
