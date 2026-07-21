import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getIdentityChangeEpoch } from "./identity-change-invalidation.js";
import {
  _setIdentityFileBeforeCommitHookForTests,
  resolveWorkspaceIdentityWriteTarget,
  writeIdentityFileAtomically,
  writeIdentityFileIfTarget,
} from "./identity-file-write.js";

const originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
let workspaceDir = "";

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  workspaceDir = realpathSync(
    mkdtempSync(join(tmpdir(), "identity-writer-test-")),
  );
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
});

afterEach(() => {
  _setIdentityFileBeforeCommitHookForTests(null);
  rmSync(workspaceDir, { recursive: true, force: true });
  if (originalWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  }
});

describe("identity write target resolution", () => {
  test("detects symlink, hard-link, and filesystem case aliases", () => {
    const identityPath = join(workspaceDir, "IDENTITY.md");
    const symlinkPath = join(workspaceDir, "identity-symlink.md");
    const hardLinkPath = join(workspaceDir, "identity-hard-link.md");
    const caseAliasPath = join(workspaceDir, "identity.MD");
    writeFileSync(identityPath, "original");
    symlinkSync(identityPath, symlinkPath);
    linkSync(identityPath, hardLinkPath);

    expect(resolveWorkspaceIdentityWriteTarget(symlinkPath)).toBe(identityPath);
    expect(resolveWorkspaceIdentityWriteTarget(hardLinkPath)).toBe(
      identityPath,
    );

    if (existsSync(caseAliasPath)) {
      expect(resolveWorkspaceIdentityWriteTarget(caseAliasPath)).toBe(
        identityPath,
      );
    }
  });

  test("fails closed for an existing alias whose target cannot be resolved", () => {
    const danglingAlias = join(workspaceDir, "dangling.md");
    symlinkSync(join(workspaceDir, "missing.md"), danglingAlias);

    expect(() => resolveWorkspaceIdentityWriteTarget(danglingAlias)).toThrow(
      "Could not safely resolve identity write target",
    );
  });
});

describe("identity writer coordination", () => {
  test("serializes an alias writer behind an in-flight canonical write", async () => {
    const identityPath = join(workspaceDir, "IDENTITY.md");
    const aliasPath = join(workspaceDir, "identity-alias.md");
    writeFileSync(identityPath, "original");
    symlinkSync(identityPath, aliasPath);

    const beforeEpoch = getIdentityChangeEpoch();
    const firstCommitReached = createDeferred();
    const resumeFirstCommit = createDeferred();
    let paused = false;
    _setIdentityFileBeforeCommitHookForTests(async () => {
      if (paused) return;
      paused = true;
      firstCommitReached.resolve();
      await resumeFirstCommit.promise;
    });

    const firstWrite = writeIdentityFileAtomically(identityPath, "first");
    await firstCommitReached.promise;

    let aliasWriteSettled = false;
    const aliasWrite = writeIdentityFileIfTarget(aliasPath, "second").finally(
      () => {
        aliasWriteSettled = true;
      },
    );
    await Promise.resolve();
    expect(aliasWriteSettled).toBe(false);

    resumeFirstCommit.resolve();
    await expect(firstWrite).resolves.toBeUndefined();
    await expect(aliasWrite).resolves.toBe(true);

    expect(readFileSync(identityPath, "utf-8")).toBe("second");
    expect(getIdentityChangeEpoch()).toBe(beforeEpoch + 2);
  });

  test("routes a hard-link destination through the canonical identity writer", async () => {
    const identityPath = join(workspaceDir, "IDENTITY.md");
    const hardLinkPath = join(workspaceDir, "identity-hard-link.md");
    writeFileSync(identityPath, "original");
    linkSync(identityPath, hardLinkPath);

    await expect(
      writeIdentityFileIfTarget(hardLinkPath, "updated"),
    ).resolves.toBe(true);
    expect(readFileSync(identityPath, "utf-8")).toBe("updated");
  });
});
