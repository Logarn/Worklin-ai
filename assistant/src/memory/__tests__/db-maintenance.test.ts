/**
 * Tests for safe online `db-maintenance.ts` orchestration.
 *
 * The contract this PR locks in:
 *   1. Automatic maintenance waits for real customer activity.
 *   2. Maintenance remains on the daemon's coordinated connection.
 *   3. `maybeRunDbMaintenance` is genuinely async — callers can `await`
 *      it and observe completion.
 *   4. The 24 h interval guard short-circuits a recent re-run.
 *
 * The per-file temp workspace is set up by `test-preload.ts`; tests just
 * dynamic-import the DB modules so they resolve paths under that temp dir.
 */
import { beforeEach, describe, expect, test } from "bun:test";

const { getSqlite } = await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { deleteMemoryCheckpoint, getMemoryCheckpoint } =
  await import("../checkpoints.js");
const { maybeRunDbMaintenance } = await import("../db-maintenance.js");
const { getLastUserMessageTimestamp } = await import("../conversation-crud.js");

initializeDb();

const MAINTENANCE_CHECKPOINT_KEY = "db_maintenance:last_run";
const QUIET_PERIOD_MS = 3 * 60 * 60 * 1000;

beforeEach(() => {
  deleteMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY);
  const sqlite = getSqlite();
  sqlite.exec("DELETE FROM messages");
  sqlite.exec("DELETE FROM conversations");
});

/** Insert a message row directly, bypassing indexing/job side effects. */
function insertMessage(role: "user" | "assistant", createdAt: number): void {
  const sqlite = getSqlite();
  const convId = `conv-${createdAt}-${role}`;
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO conversations (id, created_at, updated_at) VALUES (?, ?, ?)",
    )
    .run(convId, createdAt, createdAt);
  sqlite
    .prepare(
      "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(`msg-${createdAt}-${role}`, convId, role, "[]", createdAt);
}

describe("maybeRunDbMaintenance", () => {
  test("returns a Promise that resolves", async () => {
    const result = maybeRunDbMaintenance();
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  test("respects the 24h interval and skips when last run was recent", async () => {
    const now = Date.now();
    const recent = now - 60_000;
    const { setMemoryCheckpoint } = await import("../checkpoints.js");
    setMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY, String(recent));

    await maybeRunDbMaintenance(now);

    expect(getMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY)).toBe(
      String(recent),
    );
  });

  test("stamps the checkpoint after a maintenance run", async () => {
    const now = Date.now();
    insertMessage("user", now - (QUIET_PERIOD_MS + 60_000));
    await maybeRunDbMaintenance(now);

    expect(getMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY)).toBe(String(now));
  });

  test("defers maintenance while the last user message is within the quiet period", async () => {
    /** Maintenance must not run while the user is active. */
    // GIVEN the user sent a message one minute ago (well within the quiet period)
    const now = Date.now();
    insertMessage("user", now - 60_000);

    // WHEN maintenance is considered
    await maybeRunDbMaintenance(now);

    // THEN it is deferred — the checkpoint is never stamped, so a later idle
    // tick will retry
    expect(getMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY)).toBeNull();
  });

  test("runs maintenance once the quiet period has elapsed since the last user message", async () => {
    /** After the user has been quiet for longer than the quiet period,
     *  maintenance is allowed to run. */
    // GIVEN the last user message is older than the quiet period
    const now = Date.now();
    insertMessage("user", now - (QUIET_PERIOD_MS + 60_000));

    // WHEN maintenance is considered
    await maybeRunDbMaintenance(now);

    // THEN it runs and stamps the checkpoint
    expect(getMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY)).toBe(String(now));
  });

  test("defers maintenance when no user message exists", async () => {
    // GIVEN no user messages exist
    const now = Date.now();

    // WHEN maintenance is considered
    await maybeRunDbMaintenance(now);

    // THEN startup stays free of automatic database maintenance
    expect(getMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY)).toBeNull();
  });

  test("a recent assistant message does not keep maintenance deferred", async () => {
    /** The gate keys off user activity only — background assistant writes
     *  must not postpone maintenance indefinitely. */
    // GIVEN the user has been quiet past the quiet period
    const now = Date.now();
    insertMessage("user", now - (QUIET_PERIOD_MS + 60_000));
    // AND the assistant wrote a message recently
    insertMessage("assistant", now - 60_000);

    // WHEN maintenance is considered
    await maybeRunDbMaintenance(now);

    // THEN it still runs, since only user activity gates it
    expect(getMemoryCheckpoint(MAINTENANCE_CHECKPOINT_KEY)).toBe(String(now));
  });
});

describe("getLastUserMessageTimestamp", () => {
  test("returns 0 when no user message exists", () => {
    /** With only non-user rows present, there is no user activity to report. */
    // GIVEN only an assistant message exists
    insertMessage("assistant", Date.now());

    // WHEN the last user message timestamp is read
    const result = getLastUserMessageTimestamp();

    // THEN it reports 0 (no user activity)
    expect(result).toBe(0);
  });

  test("returns the most recent user message by timestamp, ignoring assistant rows", () => {
    /** The lookup reports the newest user-message timestamp and must skip
     *  non-user rows even when they are more recent. */
    // GIVEN two user messages and a newer assistant message
    const base = Date.now();
    insertMessage("user", base - 10_000);
    insertMessage("user", base - 5_000);
    insertMessage("assistant", base);

    // WHEN the last user message timestamp is read
    const result = getLastUserMessageTimestamp();

    // THEN it returns the most recent user message, not the assistant row
    expect(result).toBe(base - 5_000);
  });

  test("reports the newest user timestamp even when an older turn was inserted later", () => {
    /** `forkConversation` copies a parent's user turns into the fork with
     *  their original (older) `created_at` but fresh row ids, so insertion
     *  order can place an old turn last. The lookup must key off `created_at`
     *  so a fork can't make recent activity look stale and prematurely
     *  un-gate maintenance. */
    // GIVEN a recent user message
    const base = Date.now();
    insertMessage("user", base - 5_000);
    // AND a later insert of an older user turn (as a fork copy would produce)
    insertMessage("user", base - 60 * 60 * 1000);

    // WHEN the last user message timestamp is read
    const result = getLastUserMessageTimestamp();

    // THEN it reports the genuinely most recent turn, not the last-inserted one
    expect(result).toBe(base - 5_000);
  });
});
