import { beforeEach, describe, expect, mock, test } from "bun:test";

const readMock = mock(async (_options: unknown) => ({
  data: { access_consented: false, can_update: true },
  error: undefined,
  response: new Response(null, { status: 200 }),
}));
const updateMock = mock(async (_options: unknown) => ({
  data: { access_consented: true, can_update: true },
  error: undefined,
  response: new Response(null, { status: 200 }),
}));

mock.module("@/generated/api/sdk.gen", () => ({
  assistantsAccessConsentDetailRead: readMock,
  assistantsAccessConsentDetailPartialUpdate: updateMock,
}));

const { getAssistantAccessConsent, updateAssistantAccessConsent } =
  await import("@/domains/settings/api/assistant-access-consent");

beforeEach(() => {
  readMock.mockClear();
  updateMock.mockClear();
});

describe("assistant access consent API", () => {
  test("reads the explicitly selected assistant", async () => {
    expect(await getAssistantAccessConsent("assistant-1")).toEqual({
      access_consented: false,
      can_update: true,
    });
    expect(readMock.mock.calls[0]![0]).toMatchObject({
      path: { id: "assistant-1" },
    });
  });

  test("updates the selected assistant with a navigation-safe request", async () => {
    expect(await updateAssistantAccessConsent("assistant-1", true)).toEqual({
      access_consented: true,
      can_update: true,
    });
    expect(updateMock.mock.calls[0]![0]).toMatchObject({
      path: { id: "assistant-1" },
      body: { access_consented: true },
      keepalive: true,
    });
  });
});
