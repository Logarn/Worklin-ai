import { describe, expect, test } from "bun:test";

import {
  canonicalizeAssistantRequestPath,
  normalizeHttpPath,
  pathEquals,
  pathIsOrStartsWith,
} from "./http-paths.js";

describe("http path helpers", () => {
  test("normalizes trailing slashes without changing root", () => {
    expect(normalizeHttpPath("/")).toBe("/");
    expect(normalizeHttpPath("/v1/assistants")).toBe("/v1/assistants");
    expect(normalizeHttpPath("/v1/assistants/")).toBe("/v1/assistants");
    expect(normalizeHttpPath("/v1/assistants///")).toBe("/v1/assistants");
  });

  test("matches exact routes with or without a trailing slash", () => {
    expect(pathEquals("/v1/assistants", "/v1/assistants/")).toBe(true);
    expect(pathEquals("/v1/assistants/", "/v1/assistants")).toBe(true);
    expect(pathEquals("/v1/assistants/active", "/v1/assistants/active/")).toBe(
      true,
    );
    expect(pathEquals("/v1/assistants/active/extra", "/v1/assistants/active/"))
      .toBe(false);
  });

  test("matches a normalized prefix without matching sibling paths", () => {
    expect(pathIsOrStartsWith("/v1/assistants", "/v1/assistants/")).toBe(true);
    expect(pathIsOrStartsWith("/v1/assistants/", "/v1/assistants/")).toBe(true);
    expect(
      pathIsOrStartsWith(
        "/v1/assistants/worklin-1/conversations",
        "/v1/assistants/",
      ),
    ).toBe(true);
    expect(pathIsOrStartsWith("/v1/assistants-extra", "/v1/assistants/")).toBe(
      false,
    );
  });

  test("canonicalizes encoded action names before route classification", () => {
    expect(
      canonicalizeAssistantRequestPath(
        "/v1/assistants/asst-1/re%73tart/",
      ),
    ).toBe("/v1/assistants/asst-1/restart/");
    expect(
      canonicalizeAssistantRequestPath(
        "/v1/assistants/asst-1/term%69nal/sessions/",
      ),
    ).toBe("/v1/assistants/asst-1/terminal/sessions/");
  });

  test("rejects malformed and ambiguous assistant request paths", () => {
    const invalidPaths = [
      "/v1/assistants/asst-1/terminal//sessions/",
      "/v1/assistants/asst-1/terminal%2Fsessions/",
      "/v1/assistants/asst-1/terminal%5Csessions/",
      "/v1/assistants/asst-1/re%2573tart/",
      "/v1/assistants/asst-1/%ZZ/",
      "/v1/assistants/asst-1/%2E%2E/doctor/",
    ];

    for (const pathname of invalidPaths) {
      expect(canonicalizeAssistantRequestPath(pathname)).toBeNull();
    }
  });
});
