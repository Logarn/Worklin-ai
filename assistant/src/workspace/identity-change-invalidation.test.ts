import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _resetIdentityFreshnessForTests,
  getIdentityChangeEpoch,
  reconcileObservedIdentityChange,
} from "./identity-change-invalidation.js";

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
let workspaceDir = "";

beforeEach(() => {
  workspaceDir = realpathSync(
    mkdtempSync(join(tmpdir(), "identity-freshness-test-")),
  );
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  writeFileSync(join(workspaceDir, "IDENTITY.md"), "identity-a");
  writeFileSync(join(workspaceDir, "SOUL.md"), "soul-a");
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

describe("durable identity freshness", () => {
  test("advances for observed IDENTITY and SOUL changes including ABA", () => {
    const initial = getIdentityChangeEpoch();

    writeFileSync(join(workspaceDir, "IDENTITY.md"), "identity-b");
    expect(reconcileObservedIdentityChange()).toBe(initial + 1);

    writeFileSync(join(workspaceDir, "IDENTITY.md"), "identity-a");
    expect(reconcileObservedIdentityChange()).toBe(initial + 2);

    writeFileSync(join(workspaceDir, "SOUL.md"), "soul-b");
    expect(reconcileObservedIdentityChange()).toBe(initial + 3);
  });

  test("detects a change made while the process state was reset", () => {
    const initial = getIdentityChangeEpoch();
    _resetIdentityFreshnessForTests();

    writeFileSync(join(workspaceDir, "IDENTITY.md"), "changed while down");

    expect(getIdentityChangeEpoch()).toBe(initial + 1);
    _resetIdentityFreshnessForTests();
    expect(getIdentityChangeEpoch()).toBe(initial + 1);
  });
});
