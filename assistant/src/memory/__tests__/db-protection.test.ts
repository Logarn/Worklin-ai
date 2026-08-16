import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import {
  calculateDatabaseBackupCapacity,
  checkDatabaseHealth,
  createLocalDatabaseBackup,
} from "../db-protection.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createTempDatabase(): Promise<{ root: string; dbPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "db-protection-test-"));
  tempDirs.push(root);
  const dbPath = join(root, "assistant.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT)");
  db.exec("INSERT INTO messages (content) VALUES ('hello')");
  db.close();
  return { root, dbPath };
}

describe("checkDatabaseHealth", () => {
  test("accepts a valid SQLite database", async () => {
    const { dbPath } = await createTempDatabase();

    expect(checkDatabaseHealth(dbPath)).toEqual({
      ok: true,
      dbPath,
      pageCount: expect.any(Number),
      errors: [],
    });
  });

  test("reports a malformed database without throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "db-protection-corrupt-"));
    tempDirs.push(root);
    const dbPath = join(root, "assistant.db");
    await writeFile(dbPath, "this is not a SQLite database");

    const result = checkDatabaseHealth(dbPath);

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.dbPath).toBe(dbPath);
  });
});

describe("createLocalDatabaseBackup", () => {
  test("creates an atomic backup and retains only the newest copies", async () => {
    const { root, dbPath } = await createTempDatabase();
    const backupDir = join(root, "backups");
    await mkdir(backupDir, { recursive: true });

    for (const nowMs of [1, 2, 3, 4]) {
      const result = await createLocalDatabaseBackup({
        dbPath,
        backupDir,
        retention: 3,
        nowMs,
      });
      expect(result.sizeBytes).toBeGreaterThan(0);
    }

    const entries = await readdir(backupDir);
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.endsWith(".sqlite"))).toBe(true);
    expect(entries.some((entry) => entry.includes("-1-"))).toBe(false);
    expect(entries.some((entry) => entry.includes("-4-"))).toBe(true);
  });
});

describe("calculateDatabaseBackupCapacity", () => {
  test("requires enough room for the database and a safety margin", () => {
    const sourceSizeBytes = 700 * 1024 * 1024;
    const capacity = calculateDatabaseBackupCapacity(
      sourceSizeBytes,
      160 * 1024 * 1024,
    );

    expect(capacity.sufficient).toBe(false);
    expect(capacity.sourceSizeBytes).toBe(sourceSizeBytes);
    expect(capacity.headroomBytes).toBe(70 * 1024 * 1024);
    expect(capacity.requiredBytes).toBe(770 * 1024 * 1024);
  });

  test("accepts exactly the required capacity", () => {
    const sourceSizeBytes = 10 * 1024 * 1024;
    const requiredBytes = sourceSizeBytes + 64 * 1024 * 1024;

    expect(
      calculateDatabaseBackupCapacity(sourceSizeBytes, requiredBytes),
    ).toMatchObject({
      availableBytes: requiredBytes,
      requiredBytes,
      sourceSizeBytes,
      headroomBytes: 64 * 1024 * 1024,
      sufficient: true,
    });
  });
});
