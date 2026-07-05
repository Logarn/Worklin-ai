import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { CesRpcMethod } from "@vellumai/service-contracts/credential-rpc";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import type { CesClient } from "../credential-execution/client.js";
import {
  _resetBackend,
  getActiveBackendName,
  getSecureKeyAsync,
  setCesClient,
  setSecureKeyAsync,
} from "../security/secure-keys.js";

const rpcCall = mock(async (): Promise<unknown> => ({ found: false }));
const originalFetch = globalThis.fetch;

let rpcReady = true;

function createMockCesClient(): CesClient {
  return {
    handshake: mock(async () => ({ accepted: true })),
    call: rpcCall as CesClient["call"],
    updateAssistantApiKey: mock(async () => ({ updated: true })),
    isReady: () => rpcReady,
    close: mock(() => {}),
  };
}

describe("secure-keys managed CES failover", () => {
  beforeEach(() => {
    _resetBackend();
    rpcCall.mockClear();
    rpcReady = true;
    process.env.IS_CONTAINERIZED = "1";
    process.env.CES_CREDENTIAL_URL = "http://localhost:8090";
    process.env.CES_SERVICE_TOKEN = "test-token";
    const mockFetch = mock(async () => {
      return new Response(JSON.stringify({ value: "http-secret" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    mockFetch.preconnect = originalFetch.preconnect;
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.IS_CONTAINERIZED;
    delete process.env.CES_CREDENTIAL_URL;
    delete process.env.CES_SERVICE_TOKEN;
    _resetBackend();
  });

  test("falls back from dead CES RPC transport to CES HTTP in managed mode", async () => {
    setCesClient(createMockCesClient());

    expect(await getSecureKeyAsync("openai")).toBeUndefined();
    expect(getActiveBackendName()).toBe("ces-rpc");
    expect(rpcCall).toHaveBeenCalledTimes(1);

    rpcReady = false;

    expect(await getSecureKeyAsync("openai")).toBe("http-secret");
    expect(getActiveBackendName()).toBe("ces-http");
    expect(rpcCall).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("retries failed CES RPC writes through CES HTTP in managed mode", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const mockFetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        fetchCalls.push({ url, init });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    ) as unknown as typeof fetch;
    mockFetch.preconnect = originalFetch.preconnect;
    globalThis.fetch = mockFetch;

    rpcCall.mockResolvedValue({ ok: false });
    setCesClient(createMockCesClient());

    const ok = await setSecureKeyAsync(
      "credential/kimi/api_key",
      "test-secret",
    );

    expect(ok).toBe(true);
    expect(rpcCall).toHaveBeenCalledWith(CesRpcMethod.SetCredential, {
      account: "credential/kimi/api_key",
      value: "test-secret",
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(
      "http://localhost:8090/v1/credentials/credential%2Fkimi%2Fapi_key",
    );
    expect(fetchCalls[0]!.init?.method).toBe("POST");
    expect(getActiveBackendName()).toBe("ces-http");
  });
});
