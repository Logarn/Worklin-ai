import { describe, expect, test } from "bun:test";

import {
  runtimeFetch,
  type RuntimeFetchImplementation,
} from "./runtime-fetch.js";

describe("runtimeFetch", () => {
  test("always disables connection reuse for a private runtime request", async () => {
    let receivedInit: RequestInit | undefined;
    const fetchImplementation: RuntimeFetchImplementation = async (
      _input,
      init,
    ) => {
      receivedInit = init;
      return new Response(null, { status: 204 });
    };

    const response = await runtimeFetch(
      "http://runtime.railway.internal/readyz",
      { keepalive: true },
      fetchImplementation,
    );

    expect(response.status).toBe(204);
    expect(receivedInit?.keepalive).toBe(false);
  });
});
