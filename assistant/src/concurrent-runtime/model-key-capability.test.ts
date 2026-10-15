import { describe, expect, test } from "bun:test";

import { resolveConcurrentModelKey } from "./model-key-capability.js";

describe("concurrent model key capability resolver", () => {
  test("resolves a tenant key through the private control-plane origin", async () => {
    let observedUrl = "";
    let observedAuthorization = "";
    let observedBody: unknown;
    const key = await resolveConcurrentModelKey(
      "signed.capability.token",
      "openai",
      {
        controlPlaneUrl: "http://control-plane.railway.internal:8080",
        fetch: async (input, init) => {
          observedUrl = String(input);
          observedAuthorization =
            new Headers(init?.headers).get("authorization") ?? "";
          observedBody = JSON.parse(String(init?.body));
          return Response.json({ value: "tenant-api-key" });
        },
      },
    );

    expect(key).toBe("tenant-api-key");
    expect(observedUrl).toBe(
      "http://control-plane.railway.internal:8080/internal/v1/concurrent-runtime/model-provider-key",
    );
    expect(observedAuthorization).toBe("Bearer signed.capability.token");
    expect(observedBody).toEqual({ provider: "openai" });
  });

  test("rejects public control-plane origins before sending a capability", async () => {
    let called = false;
    await expect(
      resolveConcurrentModelKey("signed.capability.token", "openai", {
        controlPlaneUrl: "https://example.com",
        fetch: async () => {
          called = true;
          return Response.json({ value: "should-not-be-read" });
        },
      }),
    ).rejects.toThrow("must use a private host");
    expect(called).toBe(false);
  });

  test("rejects malformed key-service responses", async () => {
    await expect(
      resolveConcurrentModelKey("signed.capability.token", "openai", {
        controlPlaneUrl: "http://control-plane.railway.internal:8080",
        fetch: async () => Response.json({ value: { key: "not-a-string" } }),
      }),
    ).rejects.toThrow("response is invalid");
  });
});
