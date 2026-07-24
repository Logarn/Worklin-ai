import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { readHatchedAtSidecar } from "./hatched-date.js";
import { getIdentityChangeEpoch } from "./identity-change-invalidation.js";
import {
  _setIdentityFileBeforeCommitHookForTests,
  _setOrdinaryFileBeforeWriteHookForTests,
  IdentityFileConflictError,
  resolveWorkspaceIdentityWriteTarget,
  writeFileWithIdentityCoordination,
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
  _setOrdinaryFileBeforeWriteHookForTests(null);
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

  test("rejects hard-link identity topology without splitting either path", async () => {
    const identityPath = join(workspaceDir, "IDENTITY.md");
    const hardLinkPath = join(workspaceDir, "identity-hard-link.md");
    writeFileSync(identityPath, "original");
    linkSync(identityPath, hardLinkPath);

    await expect(
      writeIdentityFileIfTarget(hardLinkPath, "updated"),
    ).rejects.toThrow("Could not safely resolve identity write target");
    expect(readFileSync(identityPath, "utf-8")).toBe("original");
    expect(readFileSync(hardLinkPath, "utf-8")).toBe("original");
    expect(statSync(identityPath).ino).toBe(statSync(hardLinkPath).ino);
  });

  test("rejects a canonical symlink without replacing it or its target", async () => {
    const identityPath = join(workspaceDir, "IDENTITY.md");
    const targetPath = join(workspaceDir, "identity-target.md");
    writeFileSync(targetPath, "target identity");
    symlinkSync(targetPath, identityPath);

    await expect(
      writeIdentityFileAtomically(identityPath, "updated"),
    ).rejects.toThrow("Could not safely resolve identity write target");
    expect(lstatSync(identityPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(targetPath, "utf-8")).toBe("target identity");

    const unrelatedPath = join(workspaceDir, "notes.md");
    await expect(
      writeFileWithIdentityCoordination(unrelatedPath, "notes"),
    ).resolves.toMatchObject({ identityWrite: false });
    expect(readFileSync(unrelatedPath, "utf-8")).toBe("notes");
  });

  test("preserves exact mode and semantic hatched date across replacement", async () => {
    const identityPath = join(workspaceDir, "IDENTITY.md");
    writeFileSync(identityPath, "original");
    chmodSync(identityPath, 0o666);
    const originalHatchedAt = statSync(identityPath).birthtime.toISOString();

    await writeIdentityFileAtomically(identityPath, "updated");

    expect(statSync(identityPath).mode & 0o7777).toBe(0o666);
    expect(readHatchedAtSidecar()).toBe(originalHatchedAt);
  });

  test("fails when the target inode changes after comparison even with equal bytes", async () => {
    const identityPath = join(workspaceDir, "IDENTITY.md");
    const replacementPath = join(workspaceDir, "replacement.md");
    writeFileSync(identityPath, "same bytes");
    let replacementIno = 0;

    _setIdentityFileBeforeCommitHookForTests(() => {
      writeFileSync(replacementPath, "same bytes");
      replacementIno = statSync(replacementPath).ino;
      renameSync(replacementPath, identityPath);
    });

    await expect(
      writeIdentityFileAtomically(identityPath, "new bytes"),
    ).rejects.toBeInstanceOf(IdentityFileConflictError);
    expect(readFileSync(identityPath, "utf-8")).toBe("same bytes");
    expect(statSync(identityPath).ino).toBe(replacementIno);
  });

  test("fails closed when an ordinary target becomes an identity symlink", async () => {
    const identityPath = join(workspaceDir, "IDENTITY.md");
    const notesPath = join(workspaceDir, "notes.md");
    writeFileSync(identityPath, "identity");
    writeFileSync(notesPath, "notes");

    _setOrdinaryFileBeforeWriteHookForTests(() => {
      unlinkSync(notesPath);
      symlinkSync(identityPath, notesPath);
    });

    await expect(
      writeFileWithIdentityCoordination(notesPath, "replacement"),
    ).rejects.toBeInstanceOf(IdentityFileConflictError);
    expect(readFileSync(identityPath, "utf-8")).toBe("identity");
    expect(lstatSync(notesPath).isSymbolicLink()).toBe(true);
  });
});
