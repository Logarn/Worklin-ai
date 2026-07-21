import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { Mutex } from "../util/mutex.js";
import { getWorkspacePromptPath } from "../util/platform.js";
import { advanceIdentityChangeEpoch } from "./identity-change-invalidation.js";

const identityWriteLocks = new Map<string, Mutex>();

type IdentityContent = string | Uint8Array;

interface IdentitySnapshot {
  content: Buffer | null;
  mode: number | undefined;
}

interface IdentityCommitHookContext {
  identityPath: string;
}

interface ComparablePath {
  exists: boolean;
  realPath: string;
  stat: ReturnType<typeof statSync> | null;
}

type IdentityCommitHook = (
  context: IdentityCommitHookContext,
) => Promise<void> | void;

let beforeCommitHookForTests: IdentityCommitHook | null = null;

export class IdentityFileConflictError extends Error {
  constructor() {
    super(
      "The assistant identity changed while this edit was being saved. Try again.",
    );
    this.name = "IdentityFileConflictError";
  }
}

export class IdentityFileExistsError extends Error {
  readonly code = "EEXIST";

  constructor(identityPath: string) {
    super(`Destination file already exists: ${identityPath}`);
    this.name = "IdentityFileExistsError";
  }
}

export class IdentityTargetResolutionError extends Error {
  constructor(filePath: string, cause?: unknown) {
    super(`Could not safely resolve identity write target: ${filePath}`, {
      cause,
    });
    this.name = "IdentityTargetResolutionError";
  }
}

function isMissingPathError(error: unknown): boolean {
  const code =
    error instanceof Error && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

function inspectComparablePath(filePath: string): ComparablePath {
  const absolutePath = resolve(filePath);
  const trailing: string[] = [];
  let current = absolutePath;

  while (true) {
    try {
      lstatSync(current);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new IdentityTargetResolutionError(filePath, error);
      }

      const parent = dirname(current);
      if (parent === current) {
        throw new IdentityTargetResolutionError(filePath, error);
      }
      trailing.unshift(basename(current));
      current = parent;
      continue;
    }

    let realPath: string;
    try {
      realPath = realpathSync(current);
    } catch (error) {
      // An existing but unresolvable entry is commonly a dangling symlink.
      throw new IdentityTargetResolutionError(filePath, error);
    }

    if (trailing.length > 0) {
      return {
        exists: false,
        realPath: join(realPath, ...trailing),
        stat: null,
      };
    }

    try {
      return {
        exists: true,
        realPath,
        stat: statSync(absolutePath),
      };
    } catch (error) {
      throw new IdentityTargetResolutionError(filePath, error);
    }
  }
}

/**
 * Resolve a validated destination to the workspace identity file when it is a
 * direct path or a filesystem alias. Existing aliases are compared by both
 * real path and inode so symlinks, case aliases, and hard links are covered.
 */
export function resolveWorkspaceIdentityWriteTarget(
  filePath: string,
): string | null {
  const identityPath = resolve(getWorkspacePromptPath("IDENTITY.md"));
  const candidatePath = resolve(filePath);

  if (candidatePath === identityPath) {
    return identityPath;
  }

  const identity = inspectComparablePath(identityPath);
  const candidate = inspectComparablePath(candidatePath);

  if (candidate.realPath === identity.realPath) {
    return identityPath;
  }

  if (
    identity.exists &&
    candidate.exists &&
    identity.stat?.isFile() &&
    candidate.stat?.isFile() &&
    identity.stat.dev === candidate.stat.dev &&
    identity.stat.ino === candidate.stat.ino
  ) {
    return identityPath;
  }

  return null;
}

function requireWorkspaceIdentityWriteTarget(filePath: string): string {
  const identityPath = resolveWorkspaceIdentityWriteTarget(filePath);
  if (!identityPath) {
    throw new IdentityTargetResolutionError(filePath);
  }
  return identityPath;
}

function getIdentityWriteLock(identityPath: string): Mutex {
  const key = resolve(identityPath);
  let lock = identityWriteLocks.get(key);
  if (!lock) {
    lock = new Mutex();
    identityWriteLocks.set(key, lock);
  }
  return lock;
}

function toBuffer(content: IdentityContent): Buffer {
  return typeof content === "string"
    ? Buffer.from(content, "utf-8")
    : Buffer.from(content);
}

function readSnapshot(identityPath: string): IdentitySnapshot {
  if (!existsSync(identityPath)) {
    return { content: null, mode: undefined };
  }

  return {
    content: readFileSync(identityPath),
    mode: statSync(identityPath).mode,
  };
}

function contentsMatch(
  actual: Buffer | null,
  expected: Buffer | null,
): boolean {
  if (actual === null || expected === null) {
    return actual === expected;
  }
  return actual.equals(expected);
}

async function commitLocked(
  identityPath: string,
  expectedContent: Buffer | null,
  content: Buffer,
  mode: number | undefined,
): Promise<void> {
  const tempPath = `${identityPath}.${randomUUID()}.tmp`;

  try {
    writeFileSync(tempPath, content, {
      mode: mode ?? 0o666,
    });

    if (!readFileSync(tempPath).equals(content)) {
      throw new Error("Temporary identity file verification failed");
    }

    if (!contentsMatch(readSnapshot(identityPath).content, expectedContent)) {
      throw new IdentityFileConflictError();
    }

    await beforeCommitHookForTests?.({ identityPath });

    if (!contentsMatch(readSnapshot(identityPath).content, expectedContent)) {
      throw new IdentityFileConflictError();
    }

    renameSync(tempPath, identityPath);
    advanceIdentityChangeEpoch();
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function readIdentityContent(identityPath: string): Buffer | null {
  return readSnapshot(requireWorkspaceIdentityWriteTarget(identityPath))
    .content;
}

export async function writeIdentityFileAtomicallyIfUnchanged(
  identityPath: string,
  expectedContent: IdentityContent | null,
  content: IdentityContent,
): Promise<void> {
  const resolvedIdentityPath =
    requireWorkspaceIdentityWriteTarget(identityPath);
  const expectedBuffer =
    expectedContent === null ? null : toBuffer(expectedContent);
  const contentBuffer = toBuffer(content);

  await getIdentityWriteLock(resolvedIdentityPath).withLock(async () => {
    const snapshot = readSnapshot(resolvedIdentityPath);
    await commitLocked(
      resolvedIdentityPath,
      expectedBuffer,
      contentBuffer,
      snapshot.mode,
    );
  });
}

export async function writeIdentityFileAtomically(
  identityPath: string,
  content: IdentityContent,
  options?: { overwrite?: boolean },
): Promise<void> {
  const resolvedIdentityPath =
    requireWorkspaceIdentityWriteTarget(identityPath);
  const contentBuffer = toBuffer(content);

  await getIdentityWriteLock(resolvedIdentityPath).withLock(async () => {
    const snapshot = readSnapshot(resolvedIdentityPath);
    if (options?.overwrite === false && snapshot.content !== null) {
      throw new IdentityFileExistsError(resolvedIdentityPath);
    }
    await commitLocked(
      resolvedIdentityPath,
      snapshot.content,
      contentBuffer,
      snapshot.mode,
    );
  });
}

export async function writeIdentityFileIfTarget(
  filePath: string,
  content: IdentityContent,
  options?: { overwrite?: boolean },
): Promise<boolean> {
  const identityPath = resolveWorkspaceIdentityWriteTarget(filePath);
  if (!identityPath) {
    return false;
  }

  await writeIdentityFileAtomically(identityPath, content, options);
  return true;
}

export async function updateIdentityFileAtomically(
  identityPath: string,
  update: (content: string | null) => string | undefined,
): Promise<{ changed: boolean; content: string | null }> {
  const resolvedIdentityPath =
    requireWorkspaceIdentityWriteTarget(identityPath);
  return getIdentityWriteLock(resolvedIdentityPath).withLock(async () => {
    const snapshot = readSnapshot(resolvedIdentityPath);
    const currentContent = snapshot.content?.toString("utf-8") ?? null;
    const updatedContent = update(currentContent);

    if (updatedContent === undefined || updatedContent === currentContent) {
      return { changed: false, content: currentContent };
    }

    await commitLocked(
      resolvedIdentityPath,
      snapshot.content,
      Buffer.from(updatedContent, "utf-8"),
      snapshot.mode,
    );
    return { changed: true, content: updatedContent };
  });
}

export async function withIdentityFileWriteLock<T>(
  identityPath: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const resolvedIdentityPath =
    requireWorkspaceIdentityWriteTarget(identityPath);
  return getIdentityWriteLock(resolvedIdentityPath).withLock(async () => {
    const result = await operation();
    advanceIdentityChangeEpoch();
    return result;
  });
}

export function _setIdentityFileBeforeCommitHookForTests(
  hook: IdentityCommitHook | null,
): void {
  beforeCommitHookForTests = hook;
}
