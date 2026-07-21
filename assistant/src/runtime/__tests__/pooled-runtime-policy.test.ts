import { afterEach, describe, expect, test } from "bun:test";

import {
  assertPooledRuntimeAsyncOperationSupported,
  pooledRuntimeUnsupportedAsyncMessage,
} from "../pooled-runtime-policy.js";

const originalRuntimeMode = process.env.WORKLIN_RUNTIME_MODE;
const originalWorkerStackId = process.env.WORKLIN_RUNTIME_WORKER_STACK_ID;

afterEach(() => {
  restoreEnv("WORKLIN_RUNTIME_MODE", originalRuntimeMode);
  restoreEnv("WORKLIN_RUNTIME_WORKER_STACK_ID", originalWorkerStackId);
});

describe("pooled runtime interactive-only policy", () => {
  test("uses one stable rejection message for unsupported async work", () => {
    expect(
      pooledRuntimeUnsupportedAsyncMessage("asynchronous compaction"),
    ).toBe(
      "Pooled workers run in interactive-only mode. Unsupported operation: asynchronous compaction.",
    );
  });

  test("rejects in pooled mode and leaves dedicated runtimes unchanged", () => {
    process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
    expect(() =>
      assertPooledRuntimeAsyncOperationSupported("workflow runs"),
    ).toThrow(
      "Pooled workers run in interactive-only mode. Unsupported operation: workflow runs.",
    );

    process.env.WORKLIN_RUNTIME_MODE = "isolated";
    expect(() =>
      assertPooledRuntimeAsyncOperationSupported("workflow runs"),
    ).not.toThrow();
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
