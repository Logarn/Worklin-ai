import { describe, expect, test } from "bun:test";

import { normalizeHttpPath, pathEquals, pathIsOrStartsWith } from "./http-paths.js";

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
});
