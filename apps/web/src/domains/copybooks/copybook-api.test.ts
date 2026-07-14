import { afterEach, describe, expect, mock, test } from "bun:test";

import { client } from "@/generated/daemon/client.gen";

import { fetchCopybook, type CopybookDetail } from "./copybook-api";

const originalGet = client.get;

afterEach(() => {
  client.get = originalGet;
});

describe("fetchCopybook", () => {
  test("loads an assistant-scoped copybook detail", async () => {
    const copybook: CopybookDetail = {
      copybook: {
        id: "copybook-1",
        brandId: "brand-1",
        year: 2026,
        title: "Example Brand // 2026 Copy Doc",
        status: "active",
        createdAt: 1,
        updatedAt: 2,
      },
      brand: { id: "brand-1", name: "Example Brand" },
      brandBrain: null,
      months: [],
    };
    const request = mock(async () => ({
      data: copybook,
      error: undefined,
      response: new Response(JSON.stringify(copybook), { status: 200 }),
    }));
    client.get = request as typeof client.get;

    await expect(
      fetchCopybook("assistant-1", "copybook-1"),
    ).resolves.toEqual(copybook);
    expect(request).toHaveBeenCalledWith({
      url: "/v1/assistants/{assistant_id}/copybooks/{id}",
      path: { assistant_id: "assistant-1", id: "copybook-1" },
      throwOnError: false,
    });
  });

  test("throws a useful error when the copybook cannot be loaded", async () => {
    client.get = mock(async () => ({
      data: undefined,
      error: { message: "Copybook not found" },
      response: new Response(null, { status: 404 }),
    })) as typeof client.get;

    await expect(fetchCopybook("assistant-1", "missing")).rejects.toThrow(
      "Copybook not found",
    );
  });
});
