import { describe, expect, test } from "bun:test";

import { waitForProviderCallbackOutcome } from "@/lib/auth/provider-callback";

describe("waitForProviderCallbackOutcome", () => {
  test("retries a transient empty-session probe until auth succeeds", async () => {
    let calls = 0;

    const outcome = await waitForProviderCallbackOutcome(
      async () => {
        calls += 1;
        if (calls < 3) {
          return {
            ok: false as const,
            status: 401,
            errors: [],
            flows: [],
          };
        }
        return {
          ok: true as const,
          data: {
            user: {
              id: "user-1",
              display: "User",
              email: "user@example.com",
              username: "user",
              first_name: "",
              last_name: "",
              has_usable_password: false,
              is_staff: false,
            },
            methods: [],
          },
        };
      },
      { initialDelayMs: 0 },
    );

    expect(calls).toBe(3);
    expect(outcome).toEqual({ kind: "authenticated" });
  });

  test("returns provider-signup as soon as the server reports it", async () => {
    const outcome = await waitForProviderCallbackOutcome(
      async () => ({
        ok: false as const,
        status: 409,
        errors: [],
        flows: [{ id: "provider_signup", is_pending: true }],
      }),
      { initialDelayMs: 0 },
    );

    expect(outcome).toEqual({ kind: "provider_signup" });
  });

  test("returns the terminal auth-state error after exhausting retries", async () => {
    let calls = 0;

    const outcome = await waitForProviderCallbackOutcome(
      async () => {
        calls += 1;
        return {
          ok: false as const,
          status: 401,
          errors: [],
          flows: [],
        };
      },
      { maxAttempts: 4, initialDelayMs: 0 },
    );

    expect(calls).toBe(4);
    expect(outcome).toEqual({
      kind: "error",
      message: "Unexpected authentication state.",
    });
  });
});
