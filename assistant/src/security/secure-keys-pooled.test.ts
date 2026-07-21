import { afterEach, describe, expect, test } from "bun:test";

import { resolveAuth } from "../providers/inference/resolve-auth.js";
import {
  _resetBackend,
  bulkSetSecureKeysAsync,
  deleteSecureKeyAsync,
  getActiveBackendName,
  getProviderKeyAsync,
  getSecureKeyResultAsync,
  listSecureKeysAsync,
  setSecureKeyAsync,
} from "./secure-keys.js";

const originalRuntimeMode = process.env.WORKLIN_RUNTIME_MODE;
const originalWorkerStackId = process.env.WORKLIN_RUNTIME_WORKER_STACK_ID;
const originalOpenAiKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  _resetBackend();
  restoreEnv("WORKLIN_RUNTIME_MODE", originalRuntimeMode);
  restoreEnv("WORKLIN_RUNTIME_WORKER_STACK_ID", originalWorkerStackId);
  restoreEnv("OPENAI_API_KEY", originalOpenAiKey);
});

function enablePooledWorker(): void {
  process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
  process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = "worker-1";
}

describe("pooled secure key boundary", () => {
  test("never falls back to a worker-global provider environment key", async () => {
    enablePooledWorker();
    process.env.OPENAI_API_KEY = "sk-worker-global-must-not-leak";

    expect(await getProviderKeyAsync("openai")).toBeUndefined();
    expect(await getSecureKeyResultAsync("credential/openai/api_key")).toEqual({
      value: undefined,
      unreachable: true,
    });
    expect(getActiveBackendName()).toBe("pooled-control-plane");
  });

  test("never reads or mutates worker-local credential backends", async () => {
    enablePooledWorker();

    expect(await listSecureKeysAsync()).toEqual({
      accounts: [],
      unreachable: true,
    });
    expect(
      await setSecureKeyAsync(
        "credential/openai/api_key",
        "sk-must-not-be-written",
      ),
    ).toBe(false);
    expect(await deleteSecureKeyAsync("credential/openai/api_key")).toBe(
      "error",
    );
    expect(
      await bulkSetSecureKeysAsync([
        {
          account: "credential/openai/api_key",
          value: "sk-must-not-be-written",
        },
      ]),
    ).toEqual([{ account: "credential/openai/api_key", ok: false }]);
  });

  test("disables managed and environment-backed platform auth in pooled v1", async () => {
    enablePooledWorker();
    process.env.OPENAI_API_KEY = "sk-worker-global-must-not-leak";

    expect(await resolveAuth({ type: "platform" }, "openai")).toEqual({
      ok: false,
      error: { code: "platform_unavailable" },
    });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
