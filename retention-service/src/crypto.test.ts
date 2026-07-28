import { describe, expect, test } from "bun:test";

import { RetentionCrypto } from "./crypto.js";

describe("retention field encryption", () => {
  test("round trips only with the same tenant-bound context", () => {
    const crypto = new RetentionCrypto(Buffer.alloc(32, 7));
    const encrypted = crypto.encrypt(
      "customer@example.com",
      "org-a:customer:1:email",
    );

    expect(
      crypto.decrypt(encrypted, "org-a:customer:1:email"),
    ).toBe("customer@example.com");
    expect(() =>
      crypto.decrypt(encrypted, "org-b:customer:1:email"),
    ).toThrow();
  });

  test("creates stable scoped blind indexes without exposing plaintext", () => {
    const crypto = new RetentionCrypto(Buffer.alloc(32, 7));
    const left = crypto.blindIndex(" Person@Example.com ", "org-a:email");
    const right = crypto.blindIndex("person@example.com", "org-a:email");
    expect(left).toBe(right);
    expect(left).not.toContain("person");
    expect(crypto.blindIndex("person@example.com", "org-b:email")).not.toBe(
      left,
    );
  });
});
