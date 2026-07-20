import { beforeEach, describe, expect, mock, test } from "bun:test";

const getMock = mock(async () => ({
  data: {
    count: 1,
    next: null,
    previous: null,
    results: [
      {
        id: "research-1",
        assistant_id: "assistant-1",
        brand_name: "Acme",
        website_url: "https://acme.example",
        status: "queued",
        tracks: ["identity_and_offers"],
        evidence_count: 0,
        created_at: "2026-07-20T00:00:00.000Z",
        updated_at: "2026-07-20T00:00:00.000Z",
        error: null,
      },
    ],
  },
  error: undefined,
  response: { ok: true, status: 200 },
}));

mock.module("@/generated/api/client.gen", () => ({
  client: { get: getMock },
}));
mock.module("@/utils/api-errors", () => ({
  assertHasResponse: () => {},
  extractErrorMessage: () => "error",
}));

const { listBrandResearchRuns } = await import("./brand-research");

describe("brand research API", () => {
  beforeEach(() => getMock.mockClear());

  test("unwraps the control-plane paginated response", async () => {
    await expect(listBrandResearchRuns()).resolves.toEqual([
      expect.objectContaining({ id: "research-1", brand_name: "Acme" }),
    ]);
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});
