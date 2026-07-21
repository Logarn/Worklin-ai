import { describe, expect, mock, test } from "bun:test";

const putMock = mock(async (_options: unknown) => ({
  data: {
    interactive: "low",
    autonomous: "low",
    headless: "none",
  },
  error: undefined,
  response: new Response(null, { status: 200 }),
}));

mock.module("@/generated/api/client.gen", () => ({
  client: {
    put: putMock,
  },
}));

const { setGlobalThresholds } = await import("@/lib/threshold-api");

describe("setGlobalThresholds", () => {
  test("uses an assistant-scoped keepalive request for hard navigation", async () => {
    await setGlobalThresholds("assistant-1", {
      interactive: "low",
      autonomous: "low",
      headless: "none",
    });

    expect(putMock).toHaveBeenCalledTimes(1);
    expect(putMock.mock.calls[0]![0]).toMatchObject({
      url: "/v1/assistants/{assistant_id}/permissions/thresholds",
      path: { assistant_id: "assistant-1" },
      body: {
        interactive: "low",
        autonomous: "low",
        headless: "none",
      },
      keepalive: true,
    });
  });
});
