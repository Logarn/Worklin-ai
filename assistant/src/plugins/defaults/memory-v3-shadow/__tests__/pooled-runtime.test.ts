import { afterEach, describe, expect, test } from "bun:test";

import type { TurnContext } from "../../../types.js";
import { memoryV3Injector, memoryV3SpotlightInjector } from "../injector.js";

const originalRuntimeMode = process.env.WORKLIN_RUNTIME_MODE;
const originalWorkerStackId = process.env.WORKLIN_RUNTIME_WORKER_STACK_ID;

afterEach(() => {
  restoreEnv("WORKLIN_RUNTIME_MODE", originalRuntimeMode);
  restoreEnv("WORKLIN_RUNTIME_WORKER_STACK_ID", originalWorkerStackId);
});

describe("memory-v3 pooled runtime boundary", () => {
  test("does not start process-global memory-v3 work on a pooled assignment", async () => {
    process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
    process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = "worker-memory-v3-test";

    const context = {} as TurnContext;
    expect(await memoryV3Injector.produce(context)).toBeNull();
    expect(await memoryV3SpotlightInjector.produce(context)).toBeNull();
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
