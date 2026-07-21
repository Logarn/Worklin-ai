import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import { Mutex } from "../util/mutex.js";
import { getWorkspacePromptPath } from "../util/platform.js";

const identityWriteLocks = new Map<string, Mutex>();

type IdentityContent = string | Uint8Array;

interface IdentitySnapshot {
  content: Buffer | null;
  mode: number | undefined;
}

interface IdentityCommitHookContext {
  identityPath: string;
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
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function isWorkspaceIdentityPath(filePath: string): boolean {
  return resolve(filePath) === resolve(getWorkspacePromptPath("IDENTITY.md"));
}

export function readIdentityContent(identityPath: string): Buffer | null {
  return readSnapshot(identityPath).content;
}

export async function writeIdentityFileAtomicallyIfUnchanged(
  identityPath: string,
  expectedContent: IdentityContent | null,
  content: IdentityContent,
): Promise<void> {
  const expectedBuffer =
    expectedContent === null ? null : toBuffer(expectedContent);
  const contentBuffer = toBuffer(content);

  await getIdentityWriteLock(identityPath).withLock(async () => {
    const snapshot = readSnapshot(identityPath);
    await commitLocked(
      identityPath,
      expectedBuffer,
      contentBuffer,
      snapshot.mode,
    );
  });
}

export async function updateIdentityFileAtomically(
  identityPath: string,
  update: (content: string | null) => string | undefined,
): Promise<{ changed: boolean; content: string | null }> {
  return getIdentityWriteLock(identityPath).withLock(async () => {
    const snapshot = readSnapshot(identityPath);
    const currentContent = snapshot.content?.toString("utf-8") ?? null;
    const updatedContent = update(currentContent);

    if (updatedContent === undefined || updatedContent === currentContent) {
      return { changed: false, content: currentContent };
    }

    await commitLocked(
      identityPath,
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
  return getIdentityWriteLock(identityPath).withLock(async () => operation());
}

export function _setIdentityFileBeforeCommitHookForTests(
  hook: IdentityCommitHook | null,
): void {
  beforeCommitHookForTests = hook;
}
