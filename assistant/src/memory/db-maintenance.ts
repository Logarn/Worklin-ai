import { statSync } from "node:fs";

import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { getDbPath } from "../util/platform.js";
import { pruneRuns } from "../workflows/journal-store.js";
import { getMemoryCheckpoint, setMemoryCheckpoint } from "./checkpoints.js";
import { getLastUserMessageTimestamp } from "./conversation-crud.js";
import { getSqlite } from "./db-connection.js";
import {
  checkDatabaseHealth,
  protectDatabaseDuringMaintenance,
} from "./db-protection.js";

const log = getLogger("db-maintenance");

const DB_MAINTENANCE_CHECKPOINT_KEY = "db_maintenance:last_run";

interface DbStats {
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  fileSizeBytes: number | null;
}

function getDbStats(): DbStats {
  const sqlite = getSqlite();
  const pageSize = (
    sqlite.query("PRAGMA page_size").get() as { page_size: number }
  ).page_size;
  const pageCount = (
    sqlite.query("PRAGMA page_count").get() as { page_count: number }
  ).page_count;
  const freelistCount = (
    sqlite.query("PRAGMA freelist_count").get() as { freelist_count: number }
  ).freelist_count;
  let fileSizeBytes: number | null = null;
  try {
    fileSizeBytes = statSync(getDbPath()).size;
  } catch {
    /* non-fatal */
  }
  return { pageSize, pageCount, freelistCount, fileSizeBytes };
}

async function runDbMaintenance(): Promise<void> {
  const healthBefore = checkDatabaseHealth();
  if (!healthBefore.ok) {
    throw new Error(
      `Database health check failed before maintenance: ${healthBefore.errors.join("; ")}`,
    );
  }
  const backup = await protectDatabaseDuringMaintenance();
  if (!backup) {
    throw new Error("Database backup failed before maintenance.");
  }

  const before = getDbStats();
  const freelistPct =
    before.pageCount > 0
      ? ((before.freelistCount / before.pageCount) * 100).toFixed(1)
      : "0";

  log.info(
    {
      pageCount: before.pageCount,
      freelistCount: before.freelistCount,
      freelistPct,
      fileSizeBytes: before.fileSizeBytes,
    },
    "Starting database maintenance",
  );

  // Prune finished workflow runs and their journals past the retention window.
  // This is a fast bounded DELETE on the small workflow tables and runs on the
  // main connection during the idle maintenance window.
  try {
    const deletedRuns = pruneRuns(getConfig().workflows.journalRetentionDays);
    if (deletedRuns > 0) {
      log.info({ deletedRuns }, "Pruned expired workflow runs");
    }
  } catch (err) {
    log.warn({ err }, "Workflow run pruning failed (non-fatal)");
  }

  // Automatic maintenance stays on the daemon's single long-lived
  // connection. File-rewriting operations such as VACUUM require an explicit
  // offline maintenance window where no background writer can be active.
  getSqlite().exec("PRAGMA optimize");

  const after = getDbStats();
  const healthAfter = checkDatabaseHealth();
  if (!healthAfter.ok) {
    throw new Error(
      `Database health check failed after maintenance: ${healthAfter.errors.join("; ")}`,
    );
  }
  const reclaimedPages = before.pageCount - after.pageCount;
  const reclaimedBytes =
    before.fileSizeBytes != null && after.fileSizeBytes != null
      ? before.fileSizeBytes - after.fileSizeBytes
      : null;

  log.info(
    {
      beforePageCount: before.pageCount,
      afterPageCount: after.pageCount,
      reclaimedPages,
      beforeFileSizeBytes: before.fileSizeBytes,
      afterFileSizeBytes: after.fileSizeBytes,
      reclaimedBytes,
    },
    "Database maintenance complete",
  );
}

export async function maybeRunDbMaintenance(nowMs = Date.now()): Promise<void> {
  const { intervalMs, quietPeriodMs } = getConfig().memory.maintenance;

  const lastRun = parseInt(
    getMemoryCheckpoint(DB_MAINTENANCE_CHECKPOINT_KEY) ?? "0",
    10,
  );
  if (nowMs - lastRun < intervalMs) return;

  // A fresh workspace has nothing worth compacting. Waiting for real customer
  // activity also prevents startup workers from beginning maintenance while
  // the runtime is still creating its first tables and health backup.
  const lastUserMessageAt = getLastUserMessageTimestamp();
  if (lastUserMessageAt === 0) return;

  if (quietPeriodMs > 0 && nowMs - lastUserMessageAt < quietPeriodMs) {
    return;
  }

  try {
    await runDbMaintenance();
  } catch (err) {
    log.error({ err }, "Database maintenance failed unexpectedly");
  }
  // Always set checkpoint — even on failure — to avoid retry-hammering every tick.
  setMemoryCheckpoint(DB_MAINTENANCE_CHECKPOINT_KEY, String(nowMs));
}
