import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

import { getLogger } from "../util/logger.js";
import { getDbPath } from "../util/platform.js";
import { getSqlite } from "./db-connection.js";

const log = getLogger("db-protection");

const BACKUP_FILE_PREFIX = "assistant.db.backup-";
const BACKUP_FILE_PATTERN = /^assistant\.db\.backup-\d+-[0-9a-f-]+\.sqlite$/;
const DEFAULT_BACKUP_RETENTION = 3;

export interface DatabaseHealth {
  ok: boolean;
  dbPath: string;
  pageCount: number;
  errors: string[];
}

export interface DatabaseBackup {
  backupPath: string;
  sizeBytes: number;
  prunedCount: number;
}

export interface DatabaseProtectionResult {
  health: DatabaseHealth;
  backup: DatabaseBackup | null;
}

/**
 * Run a cheap, read-only corruption probe against the database file.
 *
 * `quick_check(1)` is intentionally used during normal startup: it catches
 * structural damage such as the malformed database seen in production while
 * avoiding the cost of a full `integrity_check` on a large workspace.
 */
export function checkDatabaseHealth(dbPath = getDbPath()): DatabaseHealth {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    return {
      ok: false,
      dbPath,
      pageCount: 0,
      errors: [toErrorMessage(err)],
    };
  }

  try {
    let errors: string[];
    try {
      const rows = db.query("PRAGMA quick_check(1)").all() as Array<
        Record<string, unknown>
      >;
      errors = rows
        .map((row) => String(Object.values(row)[0] ?? ""))
        .filter((message) => message !== "ok");
    } catch (err) {
      errors = [toErrorMessage(err)];
    }

    return {
      ok: errors.length === 0,
      dbPath,
      pageCount: readPageCount(db),
      errors,
    };
  } finally {
    db.close();
  }
}

/**
 * Copy a consistent SQLite main database file to the existing workspace
 * volume. The temporary file plus rename keeps a failed copy from looking
 * like a usable backup. Callers should checkpoint WAL before calling this.
 */
export async function createLocalDatabaseBackup(
  options: {
    dbPath?: string;
    backupDir?: string;
    retention?: number;
    nowMs?: number;
  } = {},
): Promise<DatabaseBackup> {
  const dbPath = options.dbPath ?? getDbPath();
  const backupDir = options.backupDir ?? join(dirname(dbPath), "backups");
  const retention = Math.max(
    1,
    Math.floor(options.retention ?? DEFAULT_BACKUP_RETENTION),
  );

  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const destination = join(
    backupDir,
    `${BACKUP_FILE_PREFIX}${options.nowMs ?? Date.now()}-${randomUUID()}.sqlite`,
  );
  const temporary = `${destination}.${process.pid}.tmp`;

  try {
    await copyFile(dbPath, temporary);
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
  } catch (err) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw err;
  }

  const prunedCount = await pruneLocalDatabaseBackups(backupDir, retention);
  const sizeBytes = (await stat(destination)).size;
  return { backupPath: destination, sizeBytes, prunedCount };
}

/**
 * Check and protect the live database during daemon startup. A failed health
 * check is reported and deliberately does not produce a backup of a damaged
 * file; the existing DB repair command remains the recovery path.
 */
export async function protectDatabaseOnStartup(): Promise<DatabaseProtectionResult> {
  const dbPath = getDbPath();
  let checkpointed = true;
  try {
    getSqlite().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (err) {
    checkpointed = false;
    log.warn(
      { err },
      "Database WAL checkpoint failed; skipping startup backup",
    );
  }

  const health = checkDatabaseHealth(dbPath);
  if (!health.ok) {
    log.error(
      { dbPath, pageCount: health.pageCount, errors: health.errors },
      "Database health check failed; startup backup skipped",
    );
    return { health, backup: null };
  }
  if (!checkpointed) return { health, backup: null };

  try {
    const backup = await createLocalDatabaseBackup({ dbPath });
    log.info(
      {
        dbPath,
        backupPath: backup.backupPath,
        sizeBytes: backup.sizeBytes,
        prunedCount: backup.prunedCount,
      },
      "Database health check passed and startup backup created",
    );
    return { health, backup };
  } catch (err) {
    log.error({ err, dbPath }, "Database backup failed after health check");
    return { health, backup: null };
  }
}

/**
 * Make the same protection available to the existing quiet-period
 * maintenance worker without changing its scheduling or adding a new timer.
 */
export async function protectDatabaseDuringMaintenance(): Promise<DatabaseBackup | null> {
  try {
    getSqlite().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (err) {
    log.warn({ err }, "Database maintenance backup failed (non-fatal)");
    return null;
  }

  try {
    const backup = await createLocalDatabaseBackup();
    log.info(
      {
        backupPath: backup.backupPath,
        sizeBytes: backup.sizeBytes,
        prunedCount: backup.prunedCount,
      },
      "Database maintenance backup created",
    );
    return backup;
  } catch (err) {
    log.warn({ err }, "Database maintenance backup failed (non-fatal)");
    return null;
  }
}

async function pruneLocalDatabaseBackups(
  backupDir: string,
  retention: number,
): Promise<number> {
  const entries = await readdir(backupDir, { withFileTypes: true });
  const backups = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && BACKUP_FILE_PATTERN.test(entry.name))
      .map(async (entry) => {
        const path = join(backupDir, entry.name);
        return { path, name: entry.name, mtimeMs: (await stat(path)).mtimeMs };
      }),
  );
  backups.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  const stale = backups.slice(retention);
  await Promise.all(stale.map((backup) => rm(backup.path, { force: true })));
  return stale.length;
}

function readPageCount(db: Database): number {
  try {
    return (
      (db.query("PRAGMA page_count").get() as { page_count?: number } | null)
        ?.page_count ?? 0
    );
  } catch {
    return 0;
  }
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
