import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

type AssistantListCall = { query?: unknown; throwOnError?: boolean };
type AssistantRetrieveCall = { path?: unknown; throwOnError?: boolean };

let localMode = false;

const assistantsListMock = mock(async (_opts: AssistantListCall) => ({
  data: {
    results: [
      { id: "self-hosted", is_local: true, created: "" },
      { id: "managed", is_local: false, created: "" },
    ],
  },
  error: undefined,
  response: { ok: true, status: 200 },
}));

const assistantsRetrieveMock = mock(async (_opts: AssistantRetrieveCall) => ({
  data: { id: "self-hosted", is_local: true, created: "" },
  error: undefined,
  response: { ok: true, status: 200 },
}));

const noop = mock(async () => ({
  data: undefined,
  error: undefined,
  response: { ok: true, status: 200 },
}));

mock.module("@/generated/api/sdk.gen", () => ({
  assistantsActivateCreate: noop,
  assistantsBackupsCreate: noop,
  assistantsBackupsRestoreCreate: noop,
  assistantsBackupsRetrieve: noop,
  assistantsHatchCreate: noop,
  assistantsList: assistantsListMock,
  assistantsRestartDetailCreate: noop,
  assistantsRetireDetailDestroy: noop,
  assistantsRetireDestroy: noop,
  assistantsRetrieve: assistantsRetrieveMock,
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  backupsCreatePost: noop,
  backupsGet: noop,
  backupsRestorePost: noop,
  diskpressureAcknowledgePost: noop,
  diskpressureStatusGet: noop,
  healthzGet: noop,
}));

mock.module("@/lib/auth/gateway-session", () => ({
  isGatewayAuthEnabled: () => false,
  isGatewayAuthMode: () => false,
  ensureGatewayToken: async () => "",
  clearGatewayToken: () => {},
  getLocalTokenUrl: () => undefined,
  getGatewayToken: () => null,
}));

mock.module("@/lib/local-mode", () => ({
  getActiveAssistant: () => null,
  getLocalGatewayUrl: () => null,
  getPlatformRuntimeUrl: () => undefined,
  getSelectedAssistant: () => undefined,
  getSelfHostedIngressUrl: () => undefined,
  isLocalAssistant: () => false,
  isLocalMode: () => localMode,
  isPlatformAssistant: () => false,
  isPlatformDisabled: () => false,
  getPlatformAssistants: () => [],
  getLocalAssistants: () => [],
  loadLockfile: async () => ({ assistants: [], activeAssistant: null }),
  primeLocalGatewayConnection: async () => {},
  primeLocalGatewayConnectionWithRepair: async () => {},
  saveLockfileAssistant: async () => {},
  setActiveLockfileAssistant: async () => {},
  syncPlatformAssistantsToLockfile: async () => {},
}));

let getAssistant: typeof import("./api").getAssistant;
let listPlatformAssistants: typeof import("./api").listPlatformAssistants;
let moduleNonce = 0;

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  localMode = false;
  assistantsListMock.mockClear();
  assistantsRetrieveMock.mockClear();
  noop.mockClear();
});

beforeEach(async () => {
  ({ getAssistant, listPlatformAssistants } = await import(
    new URL(`./api.ts?api-test=${++moduleNonce}`, import.meta.url).href,
  ));
});

describe("hosted assistant filtering", () => {
  test("getAssistant() ignores self-hosted entries returned by hosting=platform on web", async () => {
    const result = await getAssistant();
    expect(assistantsListMock).toHaveBeenCalledWith({
      query: { hosting: "platform" },
      throwOnError: false,
    });
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      data: { id: "managed", is_local: false },
    });
  });

  test("getAssistant() returns 404 on web when hosting=platform yields only self-hosted entries", async () => {
    assistantsListMock.mockImplementationOnce(async () => ({
      data: {
        results: [{ id: "self-hosted", is_local: true, created: "" }],
      },
      error: undefined,
      response: { ok: true, status: 200 },
    }));

    const result = await getAssistant();
    expect(result).toEqual({
      ok: false,
      status: 404,
      error: { detail: "No platform assistant found" },
    });
  });

  test("getAssistant() keeps platform-managed self-hosted descriptors on web", async () => {
    assistantsListMock.mockImplementationOnce(async () => ({
      data: {
        results: [
          {
            id: "managed-via-proxy",
            is_local: true,
            created: "",
            ingress_url: "https://worklin-ai-production.up.railway.app",
            platform_actor_token: "actor-token-1",
          },
        ],
      },
      error: undefined,
      response: { ok: true, status: 200 },
    }));

    const result = await getAssistant();
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      data: { id: "managed-via-proxy", is_local: true },
    });
  });

  test("listPlatformAssistants() filters out self-hosted results on web", async () => {
    const result = await listPlatformAssistants();
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      data: [{ id: "managed", is_local: false }],
    });
  });

  test("listPlatformAssistants() keeps self-hosted results in local mode", async () => {
    localMode = true;
    const result = await listPlatformAssistants();
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      data: [
        { id: "self-hosted", is_local: true },
        { id: "managed", is_local: false },
      ],
    });
  });

  test("getAssistant(id) still rejects a self-hosted assistant on web", async () => {
    const result = await getAssistant("self-hosted");
    expect(assistantsRetrieveMock).toHaveBeenCalledWith({
      path: { id: "self-hosted" },
      throwOnError: false,
    });
    expect(result).toEqual({
      ok: false,
      status: 404,
      error: { detail: "No platform assistant found" },
    });
  });

  test("getAssistant(id) accepts a platform-managed self-hosted descriptor on web", async () => {
    assistantsRetrieveMock.mockImplementationOnce(async () => ({
      data: {
        id: "managed-via-proxy",
        is_local: true,
        created: "",
        ingress_url: "https://worklin-ai-production.up.railway.app",
        platform_actor_token: "actor-token-1",
      },
      error: undefined,
      response: { ok: true, status: 200 },
    }));

    const result = await getAssistant("managed-via-proxy");
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      data: { id: "managed-via-proxy", is_local: true },
    });
  });
});
