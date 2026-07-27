import { beforeEach, describe, expect, test } from "bun:test";

import {
  clearPendingProviderSecretUnlessOwnedBy,
  PENDING_PROVIDER_KEY_STORAGE,
} from "@/lib/auth/pending-provider-secret";

beforeEach(() => {
  sessionStorage.clear();
});

describe("pending provider secret ownership", () => {
  test("keeps a key only for the same authenticated user", () => {
    sessionStorage.setItem(
      PENDING_PROVIDER_KEY_STORAGE,
      JSON.stringify({ ownerUserId: "user-a", provider: "openai", key: "secret" }),
    );

    clearPendingProviderSecretUnlessOwnedBy("user-a");

    expect(sessionStorage.getItem(PENDING_PROVIDER_KEY_STORAGE)).not.toBeNull();
  });

  test("clears a key when a different user becomes authenticated", () => {
    sessionStorage.setItem(
      PENDING_PROVIDER_KEY_STORAGE,
      JSON.stringify({ ownerUserId: "user-a", provider: "openai", key: "secret" }),
    );

    clearPendingProviderSecretUnlessOwnedBy("user-b");

    expect(sessionStorage.getItem(PENDING_PROVIDER_KEY_STORAGE)).toBeNull();
  });

  test("clears legacy unbound keys and keys after session expiry", () => {
    sessionStorage.setItem(
      PENDING_PROVIDER_KEY_STORAGE,
      JSON.stringify({ provider: "openai", key: "legacy-secret" }),
    );
    clearPendingProviderSecretUnlessOwnedBy("user-a");
    expect(sessionStorage.getItem(PENDING_PROVIDER_KEY_STORAGE)).toBeNull();

    sessionStorage.setItem(
      PENDING_PROVIDER_KEY_STORAGE,
      JSON.stringify({ ownerUserId: "user-a", provider: "openai", key: "secret" }),
    );
    clearPendingProviderSecretUnlessOwnedBy(null);
    expect(sessionStorage.getItem(PENDING_PROVIDER_KEY_STORAGE)).toBeNull();
  });
});
