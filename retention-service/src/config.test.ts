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
    expect(config.payloadStore).toEqual({
      kind: "s3",
      endpoint: "https://storage.example.test",
      name: "worklin-retention-test",
      region: "auto",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      virtualHostedStyle: true,
    });
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

  test("selects a local payload directory without S3 credentials", () => {
    const config = retentionServiceConfigFromEnv({
      ...baseEnvironment,
      WORKLIN_RETENTION_PAYLOAD_STORE: "filesystem",
      WORKLIN_RETENTION_PAYLOAD_DIRECTORY: "/data/retention-objects",
      WORKLIN_RETENTION_BUCKET_ENDPOINT: undefined,
      WORKLIN_RETENTION_BUCKET_NAME: undefined,
      WORKLIN_RETENTION_BUCKET_REGION: undefined,
      WORKLIN_RETENTION_BUCKET_ACCESS_KEY_ID: undefined,
      WORKLIN_RETENTION_BUCKET_SECRET_ACCESS_KEY: undefined,
    });
    expect(config.payloadStore).toEqual({
      kind: "filesystem",
      directory: "/data/retention-objects",
    });
  });

  test("requires a directory for filesystem payload storage", () => {
    expect(() =>
      retentionServiceConfigFromEnv({
        ...baseEnvironment,
        WORKLIN_RETENTION_PAYLOAD_STORE: "filesystem",
        WORKLIN_RETENTION_PAYLOAD_DIRECTORY: undefined,
      }),
    ).toThrow("payload directory");
  });

  test("requires an absolute filesystem payload directory", () => {
    expect(() =>
      retentionServiceConfigFromEnv({
        ...baseEnvironment,
        WORKLIN_RETENTION_PAYLOAD_STORE: "filesystem",
        WORKLIN_RETENTION_PAYLOAD_DIRECTORY: "relative/payloads",
      }),
    ).toThrow("absolute");
  });
});
