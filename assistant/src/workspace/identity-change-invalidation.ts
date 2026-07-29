import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getDataDir, getWorkspacePromptPath } from "../util/platform.js";

type IdentityChangeListener = (epoch: number) => void;

interface PersistedIdentityFreshness {
  version: 1;
  revision: number;
  contentHash: string;
}

const IDENTITY_FILES = ["IDENTITY.md", "SOUL.md"] as const;
const FRESHNESS_FILENAME = "identity-freshness.json";

let initialized = false;
let identityChangeEpoch = 0;
let identityContentHash = "";
const identityChangeListeners = new Set<IdentityChangeListener>();

function getFreshnessPath(): string {
  return join(getDataDir(), FRESHNESS_FILENAME);
}

function computeIdentityContentHash(): string {
  const hash = createHash("sha256");

  for (const file of IDENTITY_FILES) {
    hash.update(file);
    hash.update("\0");
    try {
      hash.update("present\0");
      hash.update(readFileSync(getWorkspacePromptPath(file)));
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      hash.update("missing\0");
    }
    hash.update("\0");
  }

  return hash.digest("hex");
}

function readPersistedFreshness(): PersistedIdentityFreshness | null {
  try {
    const parsed = JSON.parse(readFileSync(getFreshnessPath(), "utf-8")) as {
      version?: unknown;
      revision?: unknown;
      contentHash?: unknown;
    };
    if (
      parsed.version !== 1 ||
      typeof parsed.revision !== "number" ||
      !Number.isSafeInteger(parsed.revision) ||
      parsed.revision < 1 ||
      typeof parsed.contentHash !== "string" ||
      parsed.contentHash.length === 0
    ) {
      return null;
    }
    return {
      version: 1,
      revision: parsed.revision,
      contentHash: parsed.contentHash,
    };
  } catch {
    return null;
  }
}

function persistFreshness(): void {
  const freshnessPath = getFreshnessPath();
  const tempPath = `${freshnessPath}.${randomUUID()}.tmp`;

  try {
    mkdirSync(dirname(freshnessPath), { recursive: true });
    writeFileSync(
      tempPath,
      JSON.stringify(
        {
          version: 1,
          revision: identityChangeEpoch,
          contentHash: identityContentHash,
        } satisfies PersistedIdentityFreshness,
        null,
        2,
      ),
      { encoding: "utf-8", mode: 0o600 },
    );
    renameSync(tempPath, freshnessPath);
  } catch {
    // Content reconciliation still protects this process and the next start.
  } finally {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Best effort cleanup only.
    }
  }
}

function notifyIdentityChange(): void {
  for (const listener of identityChangeListeners) {
    try {
      listener(identityChangeEpoch);
    } catch {
      // Identity persistence must not fail because cache invalidation did.
    }
  }
}

/**
 * Reconcile the durable revision with current identity bytes. This runs on
 * reads as well as watcher notifications, so missed events and restarts cannot
 * make an old numeric epoch current again.
 */
function reconcileIdentityFreshness(): boolean {
  let currentHash: string;
  try {
    currentHash = computeIdentityContentHash();
  } catch {
    return false;
  }

  if (!initialized) {
    const persisted = readPersistedFreshness();
    identityChangeEpoch = persisted?.revision ?? 0;
    identityContentHash = persisted?.contentHash ?? "";
    initialized = true;
  }

  if (identityContentHash === currentHash && identityChangeEpoch > 0) {
    return false;
  }

  identityChangeEpoch = Math.max(1, identityChangeEpoch + 1);
  identityContentHash = currentHash;
  persistFreshness();
  notifyIdentityChange();
  return true;
}

export function getIdentityChangeEpoch(): number {
  reconcileIdentityFreshness();
  return identityChangeEpoch;
}

export function advanceIdentityChangeEpoch(): number {
  if (reconcileIdentityFreshness()) {
    return identityChangeEpoch;
  }

  identityChangeEpoch += 1;
  try {
    identityContentHash = computeIdentityContentHash();
  } catch {
    // Keep the last verified hash. A later read will reconcile when possible.
  }
  persistFreshness();
  notifyIdentityChange();
  return identityChangeEpoch;
}

/** Reconcile a watcher-observed change without double-counting our own write. */
export function reconcileObservedIdentityChange(): number {
  reconcileIdentityFreshness();
  return identityChangeEpoch;
}

export function onIdentityChange(listener: IdentityChangeListener): () => void {
  identityChangeListeners.add(listener);
  return () => identityChangeListeners.delete(listener);
}

export function _resetIdentityFreshnessForTests(): void {
  initialized = false;
  identityChangeEpoch = 0;
  identityContentHash = "";
}
