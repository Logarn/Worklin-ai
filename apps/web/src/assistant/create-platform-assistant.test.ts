/**
 * Unit tests for `createPlatformAssistant` — the primitive behind the tray
 * "New Assistant…" command. It must hatch with `mode: "create"` (so an
 * *additional* assistant is provisioned, not the existing one returned),
 * refresh the lockfile, and switch to the new assistant.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const assistantApi = await import("./api");
const selectionModule = await import("./selection");
const localModeModule = await import("../lib/local-mode");
const organizationStoreModule = await import("../stores/organization-store");
let hatchResult:
  | { ok: true; status: number; data: { id: string } }
  | { ok: false; status: number; error: Record<string, unknown> } = {
  ok: true,
  status: 201,
  data: { id: "ast-new" },
};

const hatchAssistantMock = mock(
  async (_input?: unknown, _mode?: string) => hatchResult,
);
const listPlatformAssistantsMock = mock(async () => ({
  ok: true as const,
  status: 200,
  data: [{ id: "ast-new", is_local: false, created: "" }],
}));
const setSelectedAssistantMock = mock(async (_id: string) => {});
const syncPlatformAssistantsToLockfileMock = mock(
  async (_a: unknown, _orgId?: string) => {},
);
let createPlatformAssistant: typeof import("./create-platform-assistant").createPlatformAssistant;
let moduleNonce = 0;

beforeEach(async () => {
  hatchResult = { ok: true, status: 201, data: { id: "ast-new" } };
  mock.restore();
  hatchAssistantMock.mockClear();
  listPlatformAssistantsMock.mockClear();
  setSelectedAssistantMock.mockClear();
  syncPlatformAssistantsToLockfileMock.mockClear();
  spyOn(assistantApi, "hatchAssistant").mockImplementation(
    hatchAssistantMock as typeof assistantApi.hatchAssistant,
  );
  spyOn(assistantApi, "listPlatformAssistants").mockImplementation(
    listPlatformAssistantsMock as unknown as typeof assistantApi.listPlatformAssistants,
  );
  spyOn(selectionModule, "setSelectedAssistant").mockImplementation(
    setSelectedAssistantMock as typeof selectionModule.setSelectedAssistant,
  );
  spyOn(
    localModeModule,
    "syncPlatformAssistantsToLockfile",
  ).mockImplementation(
    syncPlatformAssistantsToLockfileMock as typeof localModeModule.syncPlatformAssistantsToLockfile,
  );
  spyOn(organizationStoreModule.useOrganizationStore, "getState").mockImplementation(
    () =>
      ({
        currentOrganizationId: "org-test",
      }) as ReturnType<typeof organizationStoreModule.useOrganizationStore.getState>,
  );

  ({ createPlatformAssistant } = await import(
    new URL(`./create-platform-assistant.ts?test=${++moduleNonce}`, import.meta.url).href,
  ));
});

afterEach(() => {
  mock.restore();
});

describe("createPlatformAssistant", () => {
  test("hatches with mode=create, syncs the lockfile, and switches to the new id", async () => {
    const result = await createPlatformAssistant("My Bot");
    expect(hatchAssistantMock).toHaveBeenCalledWith({ name: "My Bot" }, "create");
    expect(syncPlatformAssistantsToLockfileMock).toHaveBeenCalledWith(
      [{ id: "ast-new", is_local: false, created: "" }],
      "org-test",
    );
    expect(setSelectedAssistantMock).toHaveBeenCalledWith("ast-new");
    expect(result).toEqual({ ok: true, id: "ast-new" });
  });

  test("omits the body when no name is given (still mode=create)", async () => {
    await createPlatformAssistant();
    expect(hatchAssistantMock).toHaveBeenCalledWith(undefined, "create");
  });

  test("returns an error and does not switch when hatch fails", async () => {
    hatchResult = { ok: false, status: 500, error: { detail: "boom" } };
    const result = await createPlatformAssistant("x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("boom");
    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
  });
});
