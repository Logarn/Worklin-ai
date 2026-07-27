import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertPooledGatewayCredentialBoundary,
  findForbiddenPooledCredentialServices,
  shouldStartSharedGatewayBackgroundServices,
} from "../pooled-runtime-startup-boundary.js";
import { POOLED_SHARED_STATE_ERROR_CODE } from "../pooled-runtime-shared-state.js";

const originalRuntimeMode = process.env.WORKLIN_RUNTIME_MODE;
const originalWorkerStackId = process.env.WORKLIN_RUNTIME_WORKER_STACK_ID;

afterEach(() => {
  if (originalRuntimeMode === undefined) {
    delete process.env.WORKLIN_RUNTIME_MODE;
  } else {
    process.env.WORKLIN_RUNTIME_MODE = originalRuntimeMode;
  }
  if (originalWorkerStackId === undefined) {
    delete process.env.WORKLIN_RUNTIME_WORKER_STACK_ID;
  } else {
    process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = originalWorkerStackId;
  }
});

describe("pooled gateway startup boundary", () => {
  test("starts process-global background services only for isolated runtimes", () => {
    process.env.WORKLIN_RUNTIME_MODE = "isolated";
    delete process.env.WORKLIN_RUNTIME_WORKER_STACK_ID;
    expect(shouldStartSharedGatewayBackgroundServices()).toBe(true);

    process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
    process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = "worker-startup-test";
    expect(shouldStartSharedGatewayBackgroundServices()).toBe(false);
  });

  test("detects all known, custom, and malformed credential entries without exposing values", () => {
    expect(
      findForbiddenPooledCredentialServices({
        credentials: [
          { service: "twilio", field: "auth_token" },
          { service: "telegram", field: "bot_token" },
          { service: "twilio", field: "account_sid" },
          { service: "anthropic", field: "api_key" },
          { service: "vellum", field: "assistant_api_key" },
        ],
      }),
    ).toEqual(["anthropic", "telegram", "twilio", "vellum"]);
    expect(
      findForbiddenPooledCredentialServices({
        credentials: [{ service: "custom_provider" }, null],
      }),
    ).toEqual(["<malformed>", "custom_provider"]);
    expect(
      findForbiddenPooledCredentialServices({ credentials: "not-an-array" }),
    ).toEqual(["<malformed>"]);
    expect(findForbiddenPooledCredentialServices(null)).toEqual([
      "<malformed>",
    ]);
  });

  test("fails closed on forbidden or unreadable pooled credential metadata", () => {
    process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
    const directory = mkdtempSync(join(tmpdir(), "pooled-gateway-startup-"));
    const metadataPath = join(directory, "metadata.json");
    try {
      writeFileSync(
        metadataPath,
        JSON.stringify({
          credentials: [{ service: "slack_channel", field: "bot_token" }],
        }),
      );
      expect(() => assertPooledGatewayCredentialBoundary(metadataPath)).toThrow(
        POOLED_SHARED_STATE_ERROR_CODE,
      );

      writeFileSync(metadataPath, "{not-json");
      expect(() => assertPooledGatewayCredentialBoundary(metadataPath)).toThrow(
        POOLED_SHARED_STATE_ERROR_CODE,
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("rejects model-key metadata in the gateway but preserves isolated behavior", () => {
    const directory = mkdtempSync(join(tmpdir(), "pooled-gateway-startup-"));
    const metadataPath = join(directory, "metadata.json");
    try {
      writeFileSync(
        metadataPath,
        JSON.stringify({
          credentials: [{ service: "anthropic", field: "api_key" }],
        }),
      );
      process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
      expect(() => assertPooledGatewayCredentialBoundary(metadataPath)).toThrow(
        POOLED_SHARED_STATE_ERROR_CODE,
      );

      writeFileSync(
        metadataPath,
        JSON.stringify({
          credentials: [{ service: "whatsapp", field: "access_token" }],
        }),
      );
      process.env.WORKLIN_RUNTIME_MODE = "isolated";
      expect(() =>
        assertPooledGatewayCredentialBoundary(metadataPath),
      ).not.toThrow();

      process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
      writeFileSync(metadataPath, JSON.stringify({ credentials: [] }));
      expect(() =>
        assertPooledGatewayCredentialBoundary(metadataPath),
      ).not.toThrow();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
