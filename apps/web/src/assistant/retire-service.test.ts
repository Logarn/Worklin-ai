/**
 * Unit tests for the retire service. The point of extracting it from the
 * settings component was so a retire can run for an arbitrary assistant id
 * (e.g. the tray "Retire <assistant>…" command) and route local-vs-platform by
 * the *target* assistant rather than the currently selected one. These tests
 * pin that routing plus the failure/404/cleanup behavior.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const assistantApi = await import("./api");
const localModeModule = await import("../lib/local-mode");
const organizationStoreModule = await import("../stores/organization-store");
const navigationResolverModule = await import("../lib/navigation/navigation-resolver");
const buildStateModule = await import("../lib/navigation/build-state");
const resolvedAssistantsStoreModule = await import("../stores/resolved-assistants-store");

// --- mutable mock state (set per test) --- //

let isLocalModeValue = false;
let lockfileAssistants: Array<{ assistantId: string; cloud?: string }> = [];
let storeAssistants: Array<{ id: string }> = [];
let retireByIdResult: { ok: true } | { ok: false; status: number; error: Record<string, unknown> } = { ok: true };
let retireLocalResult: { ok: true } | { ok: false; error?: string } = { ok: true };

// --- module mocks --- //

const retireAssistantByIdMock = mock(async (_id: string) => retireByIdResult);
const listPlatformAssistantsMock = mock(async () => ({
  ok: true as const,
  status: 200,
  data: [{ id: "p1", is_local: false, created: "" }],
}));

const retireLocalAssistantMock = mock(async (_id: string) => retireLocalResult);
const syncPlatformAssistantsToLockfileMock = mock(
  async (_a: unknown, _orgId?: string) => {},
);

const removeMock = mock((assistantId: string) => {
  storeAssistants = storeAssistants.filter((a) => a.id !== assistantId);
});
let retireAssistant: typeof import("./retire-service").retireAssistant;
let moduleNonce = 0;

beforeEach(async () => {
  isLocalModeValue = false;
  lockfileAssistants = [];
  storeAssistants = [];
  retireByIdResult = { ok: true };
  retireLocalResult = { ok: true };
  mock.restore();
  retireAssistantByIdMock.mockClear();
  listPlatformAssistantsMock.mockClear();
  retireLocalAssistantMock.mockClear();
  syncPlatformAssistantsToLockfileMock.mockClear();
  removeMock.mockClear();

  spyOn(assistantApi, "retireAssistantById").mockImplementation(
    retireAssistantByIdMock as typeof assistantApi.retireAssistantById,
  );
  spyOn(assistantApi, "listPlatformAssistants").mockImplementation(
    listPlatformAssistantsMock as unknown as typeof assistantApi.listPlatformAssistants,
  );
  spyOn(localModeModule, "getLockfile").mockImplementation(() => ({
    assistants: lockfileAssistants,
    activeAssistant: null,
  }));
  spyOn(localModeModule, "isLocalAssistant").mockImplementation(
    (a: { cloud?: string }) => a.cloud !== "vellum",
  );
  spyOn(localModeModule, "isLocalMode").mockImplementation(() => isLocalModeValue);
  spyOn(localModeModule, "retireLocalAssistant").mockImplementation(
    retireLocalAssistantMock as typeof localModeModule.retireLocalAssistant,
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
  spyOn(navigationResolverModule, "resolveNavigation").mockImplementation(
    ((state: Record<string, unknown>, query: { kind: string }) => {
      if (query.kind !== "post-retire") return { action: "allow" };
      if (state.hasAssistants) return { action: "redirect", to: state.isLocalMode ? "/assistant/select-assistant" : "/assistant" };
      if (!state.isLocalMode) return { action: "redirect", to: "/assistant/onboarding/privacy" };
      if (state.platformSession === "present") return { action: "redirect", to: "/assistant/onboarding/hosting" };
      return { action: "redirect", to: "/assistant/welcome" };
    }) as unknown as typeof navigationResolverModule.resolveNavigation,
  );
  spyOn(buildStateModule, "buildNavigationState").mockImplementation(
    () =>
      ({
        isLocalMode: isLocalModeValue,
        isAuthenticated: false,
        platformSession: "absent",
        hasAssistants: storeAssistants.length > 0,
      }) as ReturnType<typeof buildStateModule.buildNavigationState>,
  );
  spyOn(
    resolvedAssistantsStoreModule.useResolvedAssistantsStore,
    "getState",
  ).mockImplementation(
    () =>
      ({
        remove: removeMock,
      }) as unknown as ReturnType<typeof resolvedAssistantsStoreModule.useResolvedAssistantsStore.getState>,
  );

  ({ retireAssistant } = await import(
    new URL(`./retire-service.ts?test=${++moduleNonce}`, import.meta.url).href,
  ));
});

afterEach(() => {
  mock.restore();
});

describe("retireAssistant", () => {
  test("platform assistant routes through the platform delete by id", async () => {
    // GIVEN a platform-hosted target in web mode
    lockfileAssistants = [{ assistantId: "p1", cloud: "vellum" }];
    storeAssistants = [{ id: "p1" }];

    // WHEN retiring it
    const outcome = await retireAssistant("p1");

    // THEN the platform delete ran with that id and the local path did not
    expect(retireAssistantByIdMock).toHaveBeenCalledWith("p1");
    expect(retireLocalAssistantMock).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.nextRoute).toBe("/assistant/onboarding/privacy");
    }
  });

  test("local assistant in local mode routes through the local retire", async () => {
    // GIVEN a local target in local mode
    isLocalModeValue = true;
    lockfileAssistants = [{ assistantId: "l1", cloud: "local" }];
    storeAssistants = [{ id: "l1" }];

    // WHEN retiring it
    const outcome = await retireAssistant("l1");

    // THEN the local retire ran and the platform path did not
    expect(retireLocalAssistantMock).toHaveBeenCalledWith("l1");
    expect(retireAssistantByIdMock).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(true);
  });

  test("routes by the TARGET assistant, not local-mode alone", async () => {
    // GIVEN local mode but the *target* is a platform assistant
    isLocalModeValue = true;
    lockfileAssistants = [{ assistantId: "p1", cloud: "vellum" }];
    storeAssistants = [{ id: "p1" }];

    // WHEN retiring the platform target
    const outcome = await retireAssistant("p1");

    // THEN it uses the platform delete (not local) and re-syncs the lockfile
    expect(retireAssistantByIdMock).toHaveBeenCalledWith("p1");
    expect(retireLocalAssistantMock).not.toHaveBeenCalled();
    expect(syncPlatformAssistantsToLockfileMock).toHaveBeenCalledWith(
      [{ id: "p1", is_local: false, created: "" }],
      "org-test",
    );
    expect(outcome.ok).toBe(true);
  });

  test("a 404 from the platform delete is treated as success", async () => {
    lockfileAssistants = [{ assistantId: "p1", cloud: "vellum" }];
    storeAssistants = [{ id: "p1" }];
    retireByIdResult = { ok: false, status: 404, error: {} };

    const outcome = await retireAssistant("p1");

    expect(outcome.ok).toBe(true);
  });

  test("a non-404 platform failure surfaces the error detail", async () => {
    lockfileAssistants = [{ assistantId: "p1", cloud: "vellum" }];
    storeAssistants = [{ id: "p1" }];
    retireByIdResult = { ok: false, status: 500, error: { detail: "boom" } };

    const outcome = await retireAssistant("p1");

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("boom");
    }
  });

  test("post-retire redirects to select-assistant when other assistants remain", async () => {
    isLocalModeValue = true;
    lockfileAssistants = [
      { assistantId: "l1", cloud: "local" },
      { assistantId: "p1", cloud: "vellum" },
    ];
    storeAssistants = [{ id: "l1" }, { id: "p1" }];

    const outcome = await retireAssistant("l1");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.nextRoute).toBe("/assistant/select-assistant");
    }
  });

  test("post-retire redirects to welcome when no assistants and not logged in", async () => {
    isLocalModeValue = true;
    lockfileAssistants = [{ assistantId: "l1", cloud: "local" }];
    storeAssistants = [{ id: "l1" }];

    const outcome = await retireAssistant("l1");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.nextRoute).toBe("/assistant/welcome");
    }
  });
});
