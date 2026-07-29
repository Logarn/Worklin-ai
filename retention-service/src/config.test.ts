import { describe, expect, test } from "bun:test";

import { retentionServiceConfigFromEnv } from "./config.js";

const baseEnvironment = {
  DATABASE_URL: "postgres://runtime:secret@postgres.internal/worklin",
  WORKLIN_RETENTION_SERVICE_JWT_SECRET:
    "retention-jwt-secret-at-least-32-bytes",
  WORKLIN_RETENTION_SERVICE_WEBHOOK_SECRET:
    "retention-webhook-secret-at-least-32",
  WORKLIN_RETENTION_ENCRYPTION_KEY: "a".repeat(64),
  WORKLIN_RETENTION_BUCKET_ENDPOINT: "https://storage.example.test",
  WORKLIN_RETENTION_BUCKET_NAME: "worklin-retention-test",
  WORKLIN_RETENTION_BUCKET_REGION: "auto",
  WORKLIN_RETENTION_BUCKET_ACCESS_KEY_ID: "test-access-key",
  WORKLIN_RETENTION_BUCKET_SECRET_ACCESS_KEY: "test-secret-key",
};

describe("retention service configuration", () => {
  test("keeps external writes, sending, and migrations disabled by default", () => {
    const config = retentionServiceConfigFromEnv(baseEnvironment);
    expect(config.externalWritesEnabled).toBe(false);
    expect(config.sendEnabled).toBe(false);
    expect(config.runMigrations).toBe(false);
    expect(config.migrationDatabaseUrl).toBeNull();
    expect(config.bucket.virtualHostedStyle).toBe(false);
  });

  test("requires a separate admin connection for startup migrations", () => {
    expect(() =>
      retentionServiceConfigFromEnv({
        ...baseEnvironment,
        WORKLIN_RETENTION_RUN_MIGRATIONS: "true",
      }),
    ).toThrow("separate migration database URL");
  });

  test("requires a complete private raw-payload bucket configuration", () => {
    expect(() =>
      retentionServiceConfigFromEnv({
        ...baseEnvironment,
        WORKLIN_RETENTION_BUCKET_SECRET_ACCESS_KEY: undefined,
      }),
    ).toThrow("bucket");
  });
});
