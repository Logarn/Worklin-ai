import { describe, expect, test } from "bun:test";

import {
  authorizeRuntimeWorkerOperatorRecovery,
  parseRuntimeWorkerOperatorRecoveryRequest,
  runtimeWorkerOperatorRecoveryConfigFromEnv,
  RUNTIME_WORKER_QUARANTINE_DISCARD_CONFIRMATION,
} from "./runtime-worker-operator-recovery.js";

const TOKEN = "operator-recovery-" + "a".repeat(48);
const BINDING = {
  organizationId: "org-a",
  userId: "user-a",
  assistantId: "asst-a",
  workerStackId: "worker-1",
  leaseGeneration: 3,
  leaseExpiresAtMs: 70_000,
};

describe("runtime worker operator recovery boundary", () => {
  test("fails activation closed without a strong dedicated token", () => {
    expect(() =>
      runtimeWorkerOperatorRecoveryConfigFromEnv({}, true),
    ).toThrow("WORKLIN_RUNTIME_WORKER_OPERATOR_RECOVERY_TOKEN");
    expect(() =>
      runtimeWorkerOperatorRecoveryConfigFromEnv(
        { WORKLIN_RUNTIME_WORKER_OPERATOR_RECOVERY_TOKEN: "short" },
        true,
      ),
    ).toThrow("32-512");
    expect(
      runtimeWorkerOperatorRecoveryConfigFromEnv({}, false),
    ).toEqual({ enabled: false, tokenDigest: null });
  });

  test("accepts only the exact dedicated bearer token", () => {
    const config = runtimeWorkerOperatorRecoveryConfigFromEnv(
      { WORKLIN_RUNTIME_WORKER_OPERATOR_RECOVERY_TOKEN: TOKEN },
      true,
    );
    expect(
      authorizeRuntimeWorkerOperatorRecovery(config, `Bearer ${TOKEN}`),
    ).toBe(true);
    expect(
      authorizeRuntimeWorkerOperatorRecovery(
        config,
        `Bearer ${TOKEN.slice(0, -1)}b`,
      ),
    ).toBe(false);
    expect(authorizeRuntimeWorkerOperatorRecovery(config, undefined)).toBe(
      false,
    );
  });

  test("parses only an exact binding and requires explicit data-loss confirmation", () => {
    expect(
      parseRuntimeWorkerOperatorRecoveryRequest({
        action: "release_restart_lease",
        binding: BINDING,
      }),
    ).toEqual({
      action: "release_restart_lease",
      binding: BINDING,
    });
    expect(
      parseRuntimeWorkerOperatorRecoveryRequest({
        action: "discard_quarantined_state",
        binding: BINDING,
      }),
    ).toBeNull();
    expect(
      parseRuntimeWorkerOperatorRecoveryRequest({
        action: "discard_quarantined_state",
        binding: BINDING,
        confirmation: RUNTIME_WORKER_QUARANTINE_DISCARD_CONFIRMATION,
      }),
    ).toEqual({
      action: "discard_quarantined_state",
      binding: BINDING,
      confirmation: RUNTIME_WORKER_QUARANTINE_DISCARD_CONFIRMATION,
    });
    expect(
      parseRuntimeWorkerOperatorRecoveryRequest({
        action: "release_restart_lease",
        binding: { ...BINDING, extra: "forged" },
      }),
    ).toBeNull();
  });
});
