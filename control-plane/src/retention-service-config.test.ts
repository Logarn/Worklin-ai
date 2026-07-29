import { describe, expect, test } from "bun:test";

import { parseRetentionServiceConfig } from "./retention-service-config.js";

const JWT_SECRET = "jwt-secret-".padEnd(40, "a");
const WEBHOOK_SECRET = "webhook-secret-".padEnd(40, "b");

describe("retention service config", () => {
  test("stays disabled unless the gate is exactly true", () => {
    expect(parseRetentionServiceConfig({})).toEqual({ enabled: false });
    expect(
      parseRetentionServiceConfig({
        WORKLIN_RETENTION_SERVICE_ENABLED: "TRUE",
        WORKLIN_RETENTION_SERVICE_URL: "not-a-url",
      }),
    ).toEqual({ enabled: false });
  });

  test("parses a bounded enabled configuration", () => {
    expect(
      parseRetentionServiceConfig({
        WORKLIN_RETENTION_SERVICE_ENABLED: "true",
        WORKLIN_RETENTION_SERVICE_URL:
          "http://retention-service.railway.internal",
        WORKLIN_RETENTION_SERVICE_JWT_SECRET: JWT_SECRET,
        WORKLIN_RETENTION_SERVICE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        WORKLIN_RETENTION_SERVICE_TOKEN_TTL_SECONDS: "45",
        WORKLIN_RETENTION_SERVICE_TIMEOUT_MS: "5000",
        WORKLIN_RETENTION_SERVICE_MAX_BODY_BYTES: "4096",
      }),
    ).toEqual({
      enabled: true,
      internalBaseUrl: "http://retention-service.railway.internal/",
      serviceJwtSecret: JWT_SECRET,
      providerWebhookSecret: WEBHOOK_SECRET,
      tokenTtlSeconds: 45,
      requestTimeoutMs: 5_000,
      maxRequestBodyBytes: 4_096,
    });
  });

  test("fails closed when enabled configuration is incomplete or unsafe", () => {
    expect(() =>
      parseRetentionServiceConfig({
        WORKLIN_RETENTION_SERVICE_ENABLED: "true",
      }),
    ).toThrow("WORKLIN_RETENTION_SERVICE_URL is required");

    expect(() =>
      parseRetentionServiceConfig({
        WORKLIN_RETENTION_SERVICE_ENABLED: "true",
        WORKLIN_RETENTION_SERVICE_URL:
          "https://user:secret@retention.example.com/private",
        WORKLIN_RETENTION_SERVICE_JWT_SECRET: JWT_SECRET,
        WORKLIN_RETENTION_SERVICE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      }),
    ).toThrow("without credentials, path, query, or fragment");

    expect(() =>
      parseRetentionServiceConfig({
        WORKLIN_RETENTION_SERVICE_ENABLED: "true",
        WORKLIN_RETENTION_SERVICE_URL: "https://retention.example.com",
        WORKLIN_RETENTION_SERVICE_JWT_SECRET: JWT_SECRET,
        WORKLIN_RETENTION_SERVICE_WEBHOOK_SECRET: JWT_SECRET,
      }),
    ).toThrow("must be distinct");
  });
});
