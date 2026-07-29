import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getDataDir } from "../util/platform.js";

const HATCHED_SIDECAR_FILENAME = "hatched.json";

export function getHatchedSidecarPath(): string {
  return join(getDataDir(), HATCHED_SIDECAR_FILENAME);
}

function normalizeHatchedAt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const parsedTime = Date.parse(value);
  if (isNaN(parsedTime) || parsedTime <= 0) return undefined;

  return new Date(parsedTime).toISOString();
}

export function readHatchedAtSidecar(): string | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(getHatchedSidecarPath(), "utf-8"),
    ) as { hatchedAt?: unknown };
    return normalizeHatchedAt(parsed.hatchedAt);
  } catch {
    return undefined;
  }
}

export function writeHatchedAtSidecar(hatchedAt: string): void {
  const normalized = normalizeHatchedAt(hatchedAt);
  if (!normalized) return;

  try {
    writeHatchedAtSidecarOrThrow(normalized);
  } catch {
    // Best-effort stability; callers still return a valid timestamp.
  }
}

export function writeHatchedAtSidecarOrThrow(hatchedAt: string): void {
  const normalized = normalizeHatchedAt(hatchedAt);
  if (!normalized) {
    throw new Error("Invalid assistant hatched date");
  }

  mkdirSync(getDataDir(), { recursive: true });
  const sidecarPath = getHatchedSidecarPath();
  const tempPath = `${sidecarPath}.${randomUUID()}.tmp`;

  try {
    writeFileSync(
      tempPath,
      JSON.stringify({ hatchedAt: normalized }, null, 2),
      "utf-8",
    );
    renameSync(tempPath, sidecarPath);
  } finally {
    rmSync(tempPath, { force: true });
  }

  if (readHatchedAtSidecar() !== normalized) {
    throw new Error("Could not verify assistant hatched date persistence");
  }
}

/**
 * Persist the semantic creation date before an inode-replacing identity write.
 * Failing the write is safer than silently changing the assistant's birthday.
 */
export function ensureHatchedAtPersisted(
  identityPath: string,
  now: Date = new Date(),
): string {
  const existing = readHatchedAtSidecar();
  if (existing) return existing;

  const hatchedAt =
    readIdentityFileHatchedAt(identityPath) ?? now.toISOString();
  writeHatchedAtSidecarOrThrow(hatchedAt);
  return hatchedAt;
}

export function selectHatchedAtFromStats(stats: {
  birthtime: Date;
  mtime: Date;
}): Date | undefined {
  const candidates = [stats.birthtime, stats.mtime];
  return candidates.find((candidate) => candidate.getTime() > 0);
}

function readIdentityFileHatchedAt(identityPath: string): string | undefined {
  try {
    return selectHatchedAtFromStats(statSync(identityPath))?.toISOString();
  } catch {
    return undefined;
  }
}

export function resolveHatchedAtReadOnly(
  identityPath: string,
  now: Date = new Date(),
): string {
  return (
    readHatchedAtSidecar() ??
    readIdentityFileHatchedAt(identityPath) ??
    now.toISOString()
  );
}

export function resolveAndPersistHatchedAt(
  identityPath: string,
  now: Date = new Date(),
): string {
  const sidecarHatchedAt = readHatchedAtSidecar();
  if (sidecarHatchedAt) return sidecarHatchedAt;

  const hatchedAt =
    readIdentityFileHatchedAt(identityPath) ?? now.toISOString();
  writeHatchedAtSidecar(hatchedAt);
  return hatchedAt;
}
