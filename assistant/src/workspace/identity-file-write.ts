import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { Mutex } from "../util/mutex.js";
import { getWorkspacePromptPath } from "../util/platform.js";
import { ensureHatchedAtPersisted } from "./hatched-date.js";
import { advanceIdentityChangeEpoch } from "./identity-change-invalidation.js";

const identityWriteLock = new Mutex();

type IdentityContent = string | Uint8Array;

interface IdentitySnapshot {
  content: Buffer | null;
  mode: number | undefined;
  dev: number | undefined;
  ino: number | undefined;
  nlink: number | undefined;
}

interface IdentityCommitHookContext {
  identityPath: string;
}

interface OrdinaryWriteHookContext {
  filePath: string;
  stablePath: string;
}

interface ComparablePath {
  exists: boolean;
  realPath: string;
  stat: ReturnType<typeof statSync> | null;
}

type IdentityCommitHook = (
  context: IdentityCommitHookContext,
) => Promise<void> | void;

type OrdinaryWriteHook = (
  context: OrdinaryWriteHookContext,
) => Promise<void> | void;

let beforeCommitHookForTests: IdentityCommitHook | null = null;
let beforeOrdinaryWriteHookForTests: OrdinaryWriteHook | null = null;

export class IdentityFileConflictError extends Error {
  constructor(
    message = "The assistant identity changed while this edit was being saved. Try again.",
  ) {
    super(message);
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

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function missingFileError(filePath: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`File not found: ${filePath}`), {
    code: "ENOENT",
  });
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

function readCanonicalEntry(
  identityPath: string,
): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(identityPath);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw new IdentityTargetResolutionError(identityPath, error);
  }
}

function resolveWorkspaceIdentityWriteTargetUnlocked(
  filePath: string,
): string | null {
  const identityPath = resolve(getWorkspacePromptPath("IDENTITY.md"));
  const candidatePath = resolve(filePath);
  const canonicalEntry = readCanonicalEntry(identityPath);

  if (candidatePath === identityPath) {
    if (canonicalEntry?.isSymbolicLink()) {
      throw new IdentityTargetResolutionError(
        identityPath,
        new Error("Canonical IDENTITY.md must not be a symbolic link"),
      );
    }
    return identityPath;
  }

  if (canonicalEntry?.isSymbolicLink()) {
    let identity: ComparablePath;
    try {
      identity = inspectComparablePath(identityPath);
    } catch {
      // A dangling canonical symlink is unsafe for identity writes, but it
      // must not prevent coordinated writes to unrelated workspace files.
      return null;
    }
    const candidate = inspectComparablePath(candidatePath);
    if (
      candidate.realPath === identity.realPath ||
      (candidate.exists &&
        identity.exists &&
        candidate.stat?.isFile() &&
        identity.stat?.isFile() &&
        sameInode(candidate.stat, identity.stat))
    ) {
      throw new IdentityTargetResolutionError(
        filePath,
        new Error("Canonical IDENTITY.md must not be a symbolic link"),
      );
    }
    return null;
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

/**
 * Resolve a validated destination to the workspace identity file when it is a
 * direct path or filesystem alias. Mutation callers must use one of the
 * coordinated helpers below so this observation and the write share a lock.
 */
export function resolveWorkspaceIdentityWriteTarget(
  filePath: string,
): string | null {
  return resolveWorkspaceIdentityWriteTargetUnlocked(filePath);
}

function requireWorkspaceIdentityWriteTargetUnlocked(filePath: string): string {
  const identityPath = resolveWorkspaceIdentityWriteTargetUnlocked(filePath);
  if (!identityPath) {
    throw new IdentityTargetResolutionError(filePath);
  }
  return identityPath;
}

function toBuffer(content: IdentityContent): Buffer {
  return typeof content === "string"
    ? Buffer.from(content, "utf-8")
    : Buffer.from(content);
}

function readSnapshot(filePath: string): IdentitySnapshot {
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(filePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        content: null,
        mode: undefined,
        dev: undefined,
        ino: undefined,
        nlink: undefined,
      };
    }
    throw new IdentityTargetResolutionError(filePath, error);
  }

  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new IdentityTargetResolutionError(
      filePath,
      new Error("Identity target must be a regular file"),
    );
  }
  if (entry.nlink !== 1) {
    throw new IdentityTargetResolutionError(
      filePath,
      new Error("Identity target has hard-link aliases"),
    );
  }

  let fd: number | undefined;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (stat.dev !== entry.dev || stat.ino !== entry.ino) {
      throw new IdentityFileConflictError();
    }
    return {
      content: readFileSync(fd),
      mode: stat.mode,
      dev: stat.dev,
      ino: stat.ino,
      nlink: stat.nlink,
    };
  } catch (error) {
    if (
      error instanceof IdentityFileConflictError ||
      error instanceof IdentityTargetResolutionError
    ) {
      throw error;
    }
    throw new IdentityTargetResolutionError(filePath, error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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

function snapshotsMatch(
  actual: IdentitySnapshot,
  expected: IdentitySnapshot,
): boolean {
  return (
    contentsMatch(actual.content, expected.content) &&
    actual.mode === expected.mode &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.nlink === expected.nlink
  );
}

function writeAll(fd: number, content: Buffer): void {
  let offset = 0;
  while (offset < content.byteLength) {
    const written = writeSync(
      fd,
      content,
      offset,
      content.byteLength - offset,
      offset,
    );
    if (written <= 0) throw new Error("Could not complete file write");
    offset += written;
  }
}

function createVerifiedTempFile(
  tempPath: string,
  content: Buffer,
  exactMode: number | undefined,
): void {
  const fd = openSync(
    tempPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o666,
  );
  try {
    writeAll(fd, content);
    if (exactMode !== undefined) {
      fchmodSync(fd, exactMode & 0o7777);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  if (!readFileSync(tempPath).equals(content)) {
    throw new Error("Temporary identity file verification failed");
  }
  if (
    exactMode !== undefined &&
    (statSync(tempPath).mode & 0o7777) !== (exactMode & 0o7777)
  ) {
    throw new Error("Temporary identity file mode verification failed");
  }
}

function restoreClaimedPath(backupPath: string, identityPath: string): void {
  try {
    linkSync(backupPath, identityPath);
    unlinkSync(backupPath);
  } catch (error) {
    throw new IdentityFileConflictError(
      `The assistant identity changed during commit. Recovery copy: ${backupPath}. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function removeClaimedSnapshotIfUnchanged(
  backupPath: string,
  expected: IdentitySnapshot,
): boolean {
  try {
    if (!snapshotsMatch(readSnapshot(backupPath), expected)) return false;
    unlinkSync(backupPath);
    return true;
  } catch {
    return false;
  }
}

async function commitLocked(
  identityPath: string,
  expectedContent: Buffer | null,
  content: Buffer,
  snapshot: IdentitySnapshot,
): Promise<void> {
  if (!contentsMatch(snapshot.content, expectedContent)) {
    throw new IdentityFileConflictError();
  }

  ensureHatchedAtPersisted(identityPath);

  const tempPath = `${identityPath}.${randomUUID()}.tmp`;
  const backupPath = `${identityPath}.${randomUUID()}.claim`;
  let tempExists = false;
  let backupExists = false;

  try {
    createVerifiedTempFile(tempPath, content, snapshot.mode);
    tempExists = true;

    await beforeCommitHookForTests?.({ identityPath });

    if (snapshot.content === null) {
      try {
        linkSync(tempPath, identityPath);
      } catch (error) {
        if (isAlreadyExistsError(error)) {
          throw new IdentityFileConflictError();
        }
        throw error;
      }
      unlinkSync(tempPath);
      tempExists = false;
    } else {
      try {
        renameSync(identityPath, backupPath);
        backupExists = true;
      } catch (error) {
        if (isMissingPathError(error)) {
          throw new IdentityFileConflictError();
        }
        throw error;
      }

      let claimed: IdentitySnapshot;
      try {
        claimed = readSnapshot(backupPath);
      } catch (error) {
        restoreClaimedPath(backupPath, identityPath);
        backupExists = false;
        throw error instanceof IdentityFileConflictError
          ? error
          : new IdentityFileConflictError();
      }

      if (!snapshotsMatch(claimed, snapshot)) {
        restoreClaimedPath(backupPath, identityPath);
        backupExists = false;
        throw new IdentityFileConflictError();
      }

      try {
        linkSync(tempPath, identityPath);
      } catch (error) {
        if (isAlreadyExistsError(error)) {
          removeClaimedSnapshotIfUnchanged(backupPath, snapshot);
          backupExists = false;
          throw new IdentityFileConflictError();
        }
        restoreClaimedPath(backupPath, identityPath);
        backupExists = false;
        throw error;
      }

      unlinkSync(tempPath);
      tempExists = false;

      const installed = readSnapshot(identityPath);
      if (!contentsMatch(installed.content, content)) {
        throw new IdentityFileConflictError();
      }

      if (!removeClaimedSnapshotIfUnchanged(backupPath, snapshot)) {
        throw new IdentityFileConflictError(
          `The previous assistant identity changed during commit. Recovery copy: ${backupPath}`,
        );
      }
      backupExists = false;
    }

    const committed = readSnapshot(identityPath);
    if (!contentsMatch(committed.content, content)) {
      throw new IdentityFileConflictError();
    }
    if (
      snapshot.mode !== undefined &&
      (committed.mode! & 0o7777) !== (snapshot.mode & 0o7777)
    ) {
      throw new Error("Identity file mode changed during commit");
    }

    advanceIdentityChangeEpoch();
  } finally {
    if (tempExists) rmSync(tempPath, { force: true });
    if (backupExists) {
      // A changed claim may contain an external writer's data. Never delete it.
      removeClaimedSnapshotIfUnchanged(backupPath, snapshot);
    }
  }
}

function sameInode(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertOpenedPathIsStable(
  stablePath: string,
  openedStat: ReturnType<typeof fstatSync>,
): void {
  let current: ReturnType<typeof lstatSync>;
  try {
    current = lstatSync(stablePath);
  } catch (error) {
    throw new IdentityFileConflictError(
      `Destination changed during write: ${stablePath}. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameInode(current, openedStat)
  ) {
    throw new IdentityFileConflictError(
      `Destination changed during write: ${stablePath}`,
    );
  }
}

function assertOpenedPathIsNotIdentity(
  openedStat: ReturnType<typeof fstatSync>,
): void {
  const identityPath = resolve(getWorkspacePromptPath("IDENTITY.md"));
  let identityEntry: ReturnType<typeof lstatSync>;
  try {
    identityEntry = lstatSync(identityPath);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw new IdentityTargetResolutionError(identityPath, error);
  }

  if (identityEntry.isSymbolicLink()) {
    try {
      const identityTarget = statSync(identityPath);
      if (identityTarget.isFile() && sameInode(identityTarget, openedStat)) {
        throw new IdentityFileConflictError(
          "Destination became an alias of IDENTITY.md during write",
        );
      }
    } catch (error) {
      if (error instanceof IdentityFileConflictError) throw error;
      if (!isMissingPathError(error)) {
        throw new IdentityTargetResolutionError(identityPath, error);
      }
    }
    return;
  }
  if (identityEntry.isFile() && sameInode(identityEntry, openedStat)) {
    throw new IdentityFileConflictError(
      "Destination became an alias of IDENTITY.md during write",
    );
  }
}

async function mutateOrdinaryFileLocked(
  filePath: string,
  options: { overwrite?: boolean; mustExist?: boolean },
  update: (content: Buffer | null) => Buffer | undefined,
): Promise<{ oldContent: Buffer | null; content: Buffer | null }> {
  const comparable = inspectComparablePath(filePath);
  const stablePath = comparable.realPath;

  if (options.mustExist && !comparable.exists) {
    throw missingFileError(filePath);
  }
  if (options.overwrite === false && comparable.exists) {
    throw new IdentityFileExistsError(filePath);
  }

  await beforeOrdinaryWriteHookForTests?.({ filePath, stablePath });

  const flags = comparable.exists
    ? constants.O_RDWR | constants.O_NOFOLLOW
    : constants.O_RDWR |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW;

  let fd: number | undefined;
  try {
    fd = openSync(stablePath, flags, 0o666);
    const openedStat = fstatSync(fd);
    if (!openedStat.isFile()) {
      throw new IdentityTargetResolutionError(
        stablePath,
        new Error("Destination must be a regular file"),
      );
    }
    if (
      comparable.exists &&
      comparable.stat &&
      !sameInode(comparable.stat, openedStat)
    ) {
      throw new IdentityFileConflictError(
        `Destination changed during write: ${filePath}`,
      );
    }

    assertOpenedPathIsStable(stablePath, openedStat);
    assertOpenedPathIsNotIdentity(openedStat);

    const oldContent = comparable.exists ? readFileSync(fd) : null;
    const updatedContent = update(oldContent);
    if (updatedContent === undefined) {
      return { oldContent, content: oldContent };
    }

    assertOpenedPathIsStable(stablePath, openedStat);
    assertOpenedPathIsNotIdentity(openedStat);

    ftruncateSync(fd, 0);
    writeAll(fd, updatedContent);
    fsyncSync(fd);

    assertOpenedPathIsStable(stablePath, openedStat);
    assertOpenedPathIsNotIdentity(openedStat);
    return { oldContent, content: updatedContent };
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (
      (!comparable.exists && isAlreadyExistsError(error)) ||
      code === "ELOOP" ||
      (comparable.exists && code === "ENOENT")
    ) {
      throw new IdentityFileConflictError(
        `Destination changed during write: ${filePath}`,
      );
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface CoordinatedFileWriteResult {
  identityWrite: boolean;
  oldContent: Buffer | null;
}

export async function writeFileWithIdentityCoordination(
  filePath: string,
  content: IdentityContent,
  options?: { overwrite?: boolean },
): Promise<CoordinatedFileWriteResult> {
  const contentBuffer = toBuffer(content);
  return identityWriteLock.withLock(async () => {
    const identityPath = resolveWorkspaceIdentityWriteTargetUnlocked(filePath);
    if (identityPath) {
      const snapshot = readSnapshot(identityPath);
      if (options?.overwrite === false && snapshot.content !== null) {
        throw new IdentityFileExistsError(identityPath);
      }
      await commitLocked(
        identityPath,
        snapshot.content,
        contentBuffer,
        snapshot,
      );
      return { identityWrite: true, oldContent: snapshot.content };
    }

    const result = await mutateOrdinaryFileLocked(
      filePath,
      { overwrite: options?.overwrite },
      () => contentBuffer,
    );
    return { identityWrite: false, oldContent: result.oldContent };
  });
}

export interface CoordinatedFileUpdateResult {
  identityWrite: boolean;
  changed: boolean;
  previousContent: string;
  content: string;
}

export async function updateFileWithIdentityCoordination(
  filePath: string,
  update: (content: string) => string | undefined,
): Promise<CoordinatedFileUpdateResult> {
  return identityWriteLock.withLock(async () => {
    const identityPath = resolveWorkspaceIdentityWriteTargetUnlocked(filePath);
    if (identityPath) {
      const snapshot = readSnapshot(identityPath);
      if (snapshot.content === null) throw missingFileError(identityPath);
      const previousContent = snapshot.content.toString("utf-8");
      const updatedContent = update(previousContent);
      if (updatedContent === undefined || updatedContent === previousContent) {
        return {
          identityWrite: true,
          changed: false,
          previousContent,
          content: previousContent,
        };
      }
      await commitLocked(
        identityPath,
        snapshot.content,
        Buffer.from(updatedContent, "utf-8"),
        snapshot,
      );
      return {
        identityWrite: true,
        changed: true,
        previousContent,
        content: updatedContent,
      };
    }

    let previousContent = "";
    const result = await mutateOrdinaryFileLocked(
      filePath,
      { mustExist: true },
      (content) => {
        if (content === null) throw missingFileError(filePath);
        previousContent = content.toString("utf-8");
        const updatedContent = update(previousContent);
        return updatedContent === undefined
          ? undefined
          : Buffer.from(updatedContent, "utf-8");
      },
    );
    return {
      identityWrite: false,
      changed:
        result.content !== null &&
        !result.content.equals(result.oldContent ?? Buffer.alloc(0)),
      previousContent,
      content: result.content?.toString("utf-8") ?? previousContent,
    };
  });
}

export function readIdentityContent(identityPath: string): Buffer | null {
  return readSnapshot(requireWorkspaceIdentityWriteTargetUnlocked(identityPath))
    .content;
}

export async function writeIdentityFileAtomicallyIfUnchanged(
  identityPath: string,
  expectedContent: IdentityContent | null,
  content: IdentityContent,
): Promise<void> {
  const expectedBuffer =
    expectedContent === null ? null : toBuffer(expectedContent);
  const contentBuffer = toBuffer(content);

  await identityWriteLock.withLock(async () => {
    const resolvedIdentityPath =
      requireWorkspaceIdentityWriteTargetUnlocked(identityPath);
    const snapshot = readSnapshot(resolvedIdentityPath);
    await commitLocked(
      resolvedIdentityPath,
      expectedBuffer,
      contentBuffer,
      snapshot,
    );
  });
}

export async function writeIdentityFileAtomically(
  identityPath: string,
  content: IdentityContent,
  options?: { overwrite?: boolean },
): Promise<void> {
  const contentBuffer = toBuffer(content);

  await identityWriteLock.withLock(async () => {
    const resolvedIdentityPath =
      requireWorkspaceIdentityWriteTargetUnlocked(identityPath);
    const snapshot = readSnapshot(resolvedIdentityPath);
    if (options?.overwrite === false && snapshot.content !== null) {
      throw new IdentityFileExistsError(resolvedIdentityPath);
    }
    await commitLocked(
      resolvedIdentityPath,
      snapshot.content,
      contentBuffer,
      snapshot,
    );
  });
}

export async function writeIdentityFileIfTarget(
  filePath: string,
  content: IdentityContent,
  options?: { overwrite?: boolean },
): Promise<boolean> {
  const contentBuffer = toBuffer(content);
  return identityWriteLock.withLock(async () => {
    const identityPath = resolveWorkspaceIdentityWriteTargetUnlocked(filePath);
    if (!identityPath) return false;

    const snapshot = readSnapshot(identityPath);
    if (options?.overwrite === false && snapshot.content !== null) {
      throw new IdentityFileExistsError(identityPath);
    }
    await commitLocked(identityPath, snapshot.content, contentBuffer, snapshot);
    return true;
  });
}

export async function updateIdentityFileAtomically(
  identityPath: string,
  update: (content: string | null) => string | undefined,
): Promise<{ changed: boolean; content: string | null }> {
  return identityWriteLock.withLock(async () => {
    const resolvedIdentityPath =
      requireWorkspaceIdentityWriteTargetUnlocked(identityPath);
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
      snapshot,
    );
    return { changed: true, content: updatedContent };
  });
}

export async function withIdentityWriteCoordination<T>(
  operation: () => Promise<T> | T,
): Promise<T> {
  return identityWriteLock.withLock(async () => operation());
}

export async function withIdentityPathMutation<T>(
  paths: string[],
  operation: () => Promise<T> | T,
): Promise<T> {
  return identityWriteLock.withLock(async () => {
    const identityPath = paths
      .map((filePath) => resolveWorkspaceIdentityWriteTargetUnlocked(filePath))
      .find((target): target is string => target !== null);
    const snapshot = identityPath ? readSnapshot(identityPath) : null;
    if (identityPath) ensureHatchedAtPersisted(identityPath);

    const result = await operation();

    if (identityPath) {
      const current = readSnapshot(identityPath);
      if (!snapshot || !snapshotsMatch(snapshot, current)) {
        advanceIdentityChangeEpoch();
      }
    }
    return result;
  });
}

export async function withIdentityFileWriteLock<T>(
  identityPath: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  return identityWriteLock.withLock(async () => {
    const resolvedIdentityPath =
      requireWorkspaceIdentityWriteTargetUnlocked(identityPath);
    const snapshot = readSnapshot(resolvedIdentityPath);
    ensureHatchedAtPersisted(resolvedIdentityPath);
    const result = await operation();
    const current = readSnapshot(resolvedIdentityPath);
    if (snapshotsMatch(snapshot, current)) {
      return result;
    }
    advanceIdentityChangeEpoch();
    return result;
  });
}

export function _setIdentityFileBeforeCommitHookForTests(
  hook: IdentityCommitHook | null,
): void {
  beforeCommitHookForTests = hook;
}

export function _setOrdinaryFileBeforeWriteHookForTests(
  hook: OrdinaryWriteHook | null,
): void {
  beforeOrdinaryWriteHookForTests = hook;
}
