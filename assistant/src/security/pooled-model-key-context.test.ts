import { afterEach, describe, expect, test } from "bun:test";

import type { AuthContext } from "../runtime/auth/types.js";
import {
  assertPooledModelKeyRuntimeConfiguration,
  type PooledModelKeyFetch,
  resolvePooledModelProviderKey,
  resolvePooledModelProviderKeyForAccount,
  runWithPooledModelKeyRequestContext,
  validatePooledModelKeyControlPlaneUrl,
} from "./pooled-model-key-context.js";

const originalRuntimeMode = process.env.WORKLIN_RUNTIME_MODE;
const originalWorkerStackId = process.env.WORKLIN_RUNTIME_WORKER_STACK_ID;
const originalControlPlaneUrl = process.env.WORKLIN_CONTROL_PLANE_INTERNAL_URL;

function authContext(
  overrides: Partial<NonNullable<AuthContext["pooledWorkerLease"]>> = {},
): AuthContext {
  const lease = {
    version: 1 as const,
    organizationId: "org-1",
    userId: "user-1",
    assistantId: "asst-1",
    workerStackId: "worker-1",
    leaseGeneration: 7,
    leaseExpiresAtSeconds: 2_000,
    ...overrides,
  };
  return {
    subject: "actor:asst-1:user-1",
    principalType: "actor",
    assistantId: "asst-1",
    actorPrincipalId: "user-1",
    scopeProfile: "actor_client_v1",
    scopes: new Set(),
    policyEpoch: 1,
    tenantContext: {
      version: 1,
      organizationId: "org-1",
      userId: "user-1",
      assistantId: "asst-1",
      actorId: "user-1",
      requestId: "request-1",
    },
    pooledWorkerLease: lease,
  };
}

function enablePooledWorker(): void {
  process.env.WORKLIN_RUNTIME_MODE = "pooled_worker";
  process.env.WORKLIN_RUNTIME_WORKER_STACK_ID = "worker-1";
}

afterEach(() => {
  restoreEnv("WORKLIN_RUNTIME_MODE", originalRuntimeMode);
  restoreEnv("WORKLIN_RUNTIME_WORKER_STACK_ID", originalWorkerStackId);
  restoreEnv("WORKLIN_CONTROL_PLANE_INTERNAL_URL", originalControlPlaneUrl);
});

describe("pooled model key private origin validation", () => {
  test.each([
    "http://control-plane.railway.internal:8080",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "https://control-plane.railway.internal",
    "https://10.2.3.4",
    "https://[fd00::1]",
  ])("allows an exact private origin: %s", (raw) => {
    expect(validatePooledModelKeyControlPlaneUrl(raw).origin).toBe(
      new URL(raw).origin,
    );
  });

  test.each([
    "http://control-plane.railway.internal",
    "http://example.com:8080",
    "https://example.com",
    "ftp://control-plane.railway.internal:8080",
    "http://user:pass@control-plane.railway.internal:8080",
    "http://control-plane.railway.internal:8080/private",
    "http://control-plane.railway.internal:8080?tenant=1",
    "http://control-plane.railway.internal:8080#secret",
    " http://control-plane.railway.internal:8080",
  ])("rejects a non-private or non-origin target: %s", (raw) => {
    expect(() => validatePooledModelKeyControlPlaneUrl(raw)).toThrow();
  });

  test("fails pooled-worker startup when the private origin is absent or public", () => {
    enablePooledWorker();
    delete process.env.WORKLIN_CONTROL_PLANE_INTERNAL_URL;
    expect(() => assertPooledModelKeyRuntimeConfiguration()).toThrow(
      "WORKLIN_CONTROL_PLANE_INTERNAL_URL",
    );

    process.env.WORKLIN_CONTROL_PLANE_INTERNAL_URL =
      "https://control-plane.example.com";
    expect(() => assertPooledModelKeyRuntimeConfiguration()).toThrow(
      "private host",
    );
  });

  test("accepts the Railway private origin for pooled startup", () => {
    enablePooledWorker();
    process.env.WORKLIN_CONTROL_PLANE_INTERNAL_URL =
      "http://control-plane.railway.internal:8082";
    expect(() => assertPooledModelKeyRuntimeConfiguration()).not.toThrow();
  });

  test("does not impose pooled configuration on dedicated runtimes", () => {
    process.env.WORKLIN_RUNTIME_MODE = "isolated";
    delete process.env.WORKLIN_CONTROL_PLANE_INTERNAL_URL;
    expect(() => assertPooledModelKeyRuntimeConfiguration()).not.toThrow();
  });
});

describe("pooled model key request context", () => {
  test("strips the capability before handlers and resolves one canonical key", async () => {
    enablePooledWorker();
    let fetchCount = 0;
    const fetchImpl: PooledModelKeyFetch = async (input, init) => {
      fetchCount += 1;
      expect(String(input)).toBe(
        "http://control-plane.railway.internal:8080/internal/v1/runtime-workers/model-provider-key",
      );
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer private-capability",
      );
      expect(init?.body).toBe(JSON.stringify({ provider: "openai" }));
      return Response.json({ value: "sk-tenant-one" });
    };
    const request = new Request("http://worker.test/v1/conversations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worklin-pooled-model-key-capability": "private-capability",
      },
      body: JSON.stringify({ prompt: "hello" }),
    });

    const result = await runWithPooledModelKeyRequestContext(
      request,
      authContext(),
      async (sanitized) => {
        expect(
          sanitized.headers.has("x-worklin-pooled-model-key-capability"),
        ).toBe(false);
        expect(await sanitized.json()).toEqual({ prompt: "hello" });
        return resolvePooledModelProviderKey("openai", {
          fetch: fetchImpl,
          controlPlaneUrl: "http://control-plane.railway.internal:8080",
        });
      },
    );

    expect(result).toEqual({
      handled: true,
      value: "sk-tenant-one",
      unreachable: false,
    });
    expect(fetchCount).toBe(1);
  });

  test("fails closed without authority and on identity mismatch", async () => {
    enablePooledWorker();
    let fetchCount = 0;
    const fetchImpl: PooledModelKeyFetch = async () => {
      fetchCount += 1;
      return Response.json({ value: "must-not-be-read" });
    };
    const request = new Request("http://worker.test/v1/model", {
      headers: {
        "x-worklin-pooled-model-key-capability": "private-capability",
      },
    });

    const missingLease = authContext();
    delete missingLease.pooledWorkerLease;
    const noAuthority = await runWithPooledModelKeyRequestContext(
      request,
      missingLease,
      () =>
        resolvePooledModelProviderKey("openai", {
          fetch: fetchImpl,
          controlPlaneUrl: "http://control-plane.railway.internal:8080",
        }),
    );
    expect(noAuthority).toEqual({
      handled: true,
      value: undefined,
      unreachable: true,
    });

    const mismatch = authContext({ organizationId: "org-2" });
    const mismatched = await runWithPooledModelKeyRequestContext(
      request,
      mismatch,
      () =>
        resolvePooledModelProviderKey("openai", {
          fetch: fetchImpl,
          controlPlaneUrl: "http://control-plane.railway.internal:8080",
        }),
    );
    if (!mismatched.handled) {
      throw new Error("Expected pooled lookup handling.");
    }
    expect(mismatched.unreachable).toBe(true);

    expect(fetchCount).toBe(0);
  });

  test("does not retain authority outside the authenticated callback", async () => {
    enablePooledWorker();
    const request = new Request("http://worker.test/v1/model", {
      headers: {
        "x-worklin-pooled-model-key-capability": "private-capability",
      },
    });
    await runWithPooledModelKeyRequestContext(request, authContext(), () =>
      Promise.resolve(),
    );

    const outside = await resolvePooledModelProviderKey("openai", {
      fetch: async () => Response.json({ value: "must-not-be-read" }),
      controlPlaneUrl: "http://control-plane.railway.internal:8080",
    });
    expect(outside).toEqual({
      handled: true,
      value: undefined,
      unreachable: true,
    });
  });

  test("retains authority for delayed work while a returned response body is active", async () => {
    enablePooledWorker();
    const encoder = new TextEncoder();
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let lookupStarted!: () => void;
    const lookupStartedPromise = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    const request = new Request("http://worker.test/v1/messages", {
      headers: {
        "x-worklin-pooled-model-key-capability": "private-capability",
      },
    });

    const response = await runWithPooledModelKeyRequestContext(
      request,
      // This is the lease timestamp carried by the request's initial token.
      // The control plane has renewed the authoritative lease by the time the
      // delayed lookup runs, so the assistant must not self-expire the stream
      // from this stale snapshot.
      authContext({ leaseExpiresAtSeconds: 60 }),
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(" "));
              void (async () => {
                lookupStarted();
                await lookupGate;
                const result = await resolvePooledModelProviderKey("openai", {
                  fetch: async () =>
                    Response.json({ value: "sk-stream-bound" }),
                  controlPlaneUrl: "http://control-plane.railway.internal:8080",
                });
                controller.enqueue(
                  encoder.encode(
                    result.handled && result.value
                      ? result.value
                      : "unreachable",
                  ),
                );
                controller.close();
              })();
            },
          }),
        ),
    );

    await lookupStartedPromise;
    releaseLookup();
    expect(await response.text()).toBe(" sk-stream-bound");
  });

  test("revokes inherited authority after a returned response body completes", async () => {
    enablePooledWorker();
    let releaseLateLookup!: () => void;
    const lateLookupGate = new Promise<void>((resolve) => {
      releaseLateLookup = resolve;
    });
    let lateLookup!: Promise<
      Awaited<ReturnType<typeof resolvePooledModelProviderKey>>
    >;

    const response = await runWithPooledModelKeyRequestContext(
      new Request("http://worker.test/v1/messages", {
        headers: {
          "x-worklin-pooled-model-key-capability": "private-capability",
        },
      }),
      authContext(),
      () => {
        lateLookup = (async () => {
          await lateLookupGate;
          return resolvePooledModelProviderKey("openai", {
            fetch: async () => Response.json({ value: "must-not-escape" }),
            controlPlaneUrl: "http://control-plane.railway.internal:8080",
          });
        })();
        return new Response("complete");
      },
    );

    expect(await response.text()).toBe("complete");
    releaseLateLookup();
    expect(await lateLookup).toEqual({
      handled: true,
      value: undefined,
      unreachable: true,
    });
  });

  test("releases authority when the source closes even before EOF is read", async () => {
    enablePooledWorker();
    let releaseLateLookup!: () => void;
    const lateLookupGate = new Promise<void>((resolve) => {
      releaseLateLookup = resolve;
    });
    let lateLookup!: Promise<
      Awaited<ReturnType<typeof resolvePooledModelProviderKey>>
    >;

    const response = await runWithPooledModelKeyRequestContext(
      new Request("http://worker.test/v1/messages", {
        headers: {
          "x-worklin-pooled-model-key-capability": "private-capability",
        },
      }),
      authContext(),
      () => {
        lateLookup = (async () => {
          await lateLookupGate;
          return resolvePooledModelProviderKey("openai", {
            fetch: async () => Response.json({ value: "must-not-escape" }),
            controlPlaneUrl: "http://control-plane.railway.internal:8080",
          });
        })();
        return new Response("complete");
      },
    );

    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      "complete",
    );
    await Promise.resolve();
    releaseLateLookup();
    expect(await lateLookup).toEqual({
      handled: true,
      value: undefined,
      unreachable: true,
    });
    await reader.cancel();
  });

  test("cancelling a response revokes authority and aborts in-flight lookups", async () => {
    enablePooledWorker();
    let observedSignal: AbortSignal | undefined;
    let lookupStarted!: () => void;
    const lookupStartedPromise = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    let lookupResult!: Promise<
      Awaited<ReturnType<typeof resolvePooledModelProviderKey>>
    >;

    const response = await runWithPooledModelKeyRequestContext(
      new Request("http://worker.test/v1/messages", {
        headers: {
          "x-worklin-pooled-model-key-capability": "private-capability",
        },
      }),
      authContext(),
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(" "));
              lookupResult = resolvePooledModelProviderKey("openai", {
                fetch: async (_input, init) => {
                  observedSignal = init?.signal ?? undefined;
                  lookupStarted();
                  return new Promise<Response>((_resolve, reject) => {
                    observedSignal?.addEventListener(
                      "abort",
                      () => reject(observedSignal?.reason),
                      { once: true },
                    );
                  });
                },
                controlPlaneUrl: "http://control-plane.railway.internal:8080",
              });
            },
          }),
        ),
    );

    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(" ");
    await lookupStartedPromise;
    expect(observedSignal?.aborted).toBe(false);
    await reader.cancel("client disconnected");
    expect(observedSignal?.aborted).toBe(true);
    expect(await lookupResult).toEqual({
      handled: true,
      value: undefined,
      unreachable: true,
    });
  });

  test("rejects noncanonical accounts without reaching the control plane", async () => {
    enablePooledWorker();
    let fetched = false;
    const result = await runWithPooledModelKeyRequestContext(
      new Request("http://worker.test/v1/model", {
        headers: {
          "x-worklin-pooled-model-key-capability": "private-capability",
        },
      }),
      authContext(),
      () =>
        resolvePooledModelProviderKeyForAccount(
          "credential/github/access_token",
          {
            fetch: async () => {
              fetched = true;
              return Response.json({ value: "must-not-be-read" });
            },
            controlPlaneUrl: "http://control-plane.railway.internal:8080",
          },
        ),
    );
    expect(result).toEqual({
      handled: true,
      value: undefined,
      unreachable: false,
    });
    expect(fetched).toBe(false);
  });

  test("leaves dedicated runtime lookup behavior untouched", async () => {
    process.env.WORKLIN_RUNTIME_MODE = "isolated";
    const result = await runWithPooledModelKeyRequestContext(
      new Request("http://worker.test/v1/model", {
        headers: {
          "x-worklin-pooled-model-key-capability": "untrusted-renderer-value",
        },
      }),
      authContext(),
      async (sanitized) => {
        expect(
          sanitized.headers.has("x-worklin-pooled-model-key-capability"),
        ).toBe(false);
        return resolvePooledModelProviderKey("openai");
      },
    );
    expect(result).toEqual({ handled: false });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
