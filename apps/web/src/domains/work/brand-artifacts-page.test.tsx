import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";

const ASSISTANT_ID = "assistant-1";
const APP = {
  id: "app-1",
  name: "Launch Calculator",
  description: "A focused calculator",
  icon: null,
  createdAt: 1_750_000_000_000,
  updatedAt: 1_750_000_100_000,
};
const DOCUMENT_ARTIFACT = {
  id: "artifact-document-1",
  brandId: null,
  resourceType: "document",
  resourceId: "document-1",
  artifactType: "document",
  parentArtifactId: null,
  projectId: null,
  metadata: null,
  favorite: false,
  archived: false,
  createdAt: 1_750_000_000_000,
  updatedAt: 1_750_000_100_000,
  title: "Launch notes",
  sourceExists: true,
  childCount: 0,
};
const APP_ARTIFACT = {
  ...DOCUMENT_ARTIFACT,
  id: "artifact-app-1",
  resourceType: "app",
  resourceId: APP.id,
  artifactType: "app",
  title: APP.name,
};

let activeAssistantId = ASSISTANT_ID;
let serverApps = [APP];
let serverArtifacts = [DOCUMENT_ARTIFACT];
let deleteAppResult: (options: DeleteAppOptions) => Promise<DeleteAppResult>;

interface DeleteAppOptions {
  path: { assistant_id: string; id: string };
  throwOnError: boolean;
}

interface DeleteAppResult {
  data: { success: boolean };
}

const deleteAppCalls: DeleteAppOptions[] = [];
const clearAppHtmlCacheCalls: Array<[string, string]> = [];
const captureErrorCalls: Array<{
  error: unknown;
  context: string;
  extra?: Record<string, unknown>;
}> = [];
const toastSuccessCalls: Array<{
  message: string;
  description?: string;
}> = [];
const toastErrorCalls: Array<{
  message: string;
  description?: string;
}> = [];
const pinnedAppIds = new Set<string>();
const togglePinMock = mock((_app: typeof APP) => {});
const setTopBarCenterMock = mock((_value: ReactNode) => {});

function appsQueryKey(assistantId: string) {
  return ["apps", assistantId] as const;
}

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => activeAssistantId,
}));

mock.module("@/components/brand-research-status", () => ({
  BrandResearchStatus: () => null,
}));

mock.module("@/components/layout/chat-layout-slots-store", () => ({
  useChatLayoutSlotsStore: {
    use: { setTopBarCenter: () => setTopBarCenterMock },
  },
}));

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  appsGetOptions: ({ path }: { path: { assistant_id: string } }) => ({
    queryKey: appsQueryKey(path.assistant_id),
    queryFn: async () => ({ apps: serverApps }),
  }),
  appsGetQueryKey: ({ path }: { path: { assistant_id: string } }) =>
    appsQueryKey(path.assistant_id),
  artifactsGetOptions: ({ path }: { path: { assistant_id: string } }) => ({
    queryKey: ["artifacts", path.assistant_id],
    queryFn: async () => ({ artifacts: serverArtifacts }),
  }),
  artifactsGetQueryKey: ({ path }: { path: { assistant_id: string } }) => [
    "artifacts",
    path.assistant_id,
  ],
  brandsGetOptions: ({ path }: { path: { assistant_id: string } }) => ({
    queryKey: ["brands", path.assistant_id],
    queryFn: async () => ({
      brands: [],
      unassignedArtifactCount: serverArtifacts.length,
    }),
  }),
  brandsGetQueryKey: ({ path }: { path: { assistant_id: string } }) => [
    "brands",
    path.assistant_id,
  ],
  copybooksByIdGetOptions: ({
    path,
  }: {
    path: { assistant_id: string; id: string };
  }) => ({
    queryKey: ["copybook", path.assistant_id, path.id],
    queryFn: async () => {
      throw new Error("Unexpected copybook query");
    },
  }),
  useArtifactsByIdPatchMutation: () => ({
    isPending: false,
    mutateAsync: async () => DOCUMENT_ARTIFACT,
  }),
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  appsByIdDeletePost: async (options: DeleteAppOptions) => {
    deleteAppCalls.push(options);
    return deleteAppResult(options);
  },
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: (
    error: unknown,
    options: { context: string; extra?: Record<string, unknown> },
  ) => {
    captureErrorCalls.push({
      error,
      context: options.context,
      extra: options.extra,
    });
  },
  normalizeToError: (error: unknown) => {
    if (error instanceof Error) return error;
    if (typeof error === "object" && error !== null) {
      const detail = (error as { detail?: unknown }).detail;
      if (typeof detail === "string") return new Error(detail);
    }
    return new Error(String(error));
  },
}));

mock.module("@/stores/conversation-store", () => ({
  useConversationStore: {
    getState: () => ({ setActiveConversationId: () => {} }),
  },
}));

mock.module("@/stores/pinned-apps-store", () => ({
  usePinnedAppsStore: {
    use: {
      pinnedAppIds: () => pinnedAppIds,
      togglePin: () => togglePinMock,
    },
  },
}));

mock.module("@/stores/viewer-store", () => ({
  useViewerStore: { getState: () => ({ setMainView: () => {} }) },
}));

mock.module("@/utils/app-html-cache", () => ({
  clearAppHtmlCache: (assistantId: string, appId: string) => {
    clearAppHtmlCacheCalls.push([assistantId, appId]);
  },
}));

const Passthrough = ({ children }: { children?: ReactNode }) =>
  createElement("div", null, children);

mock.module("@vellumai/design-library", () => ({
  Button: ({
    children,
    iconOnly,
    leftIcon,
    variant: _variant,
    size: _size,
    ...props
  }: {
    children?: ReactNode;
    iconOnly?: ReactNode;
    leftIcon?: ReactNode;
    variant?: string;
    size?: string;
  } & Record<string, unknown>) =>
    createElement("button", props, leftIcon, iconOnly, children),
  ConfirmDialog: ({
    open,
    title,
    message,
    confirmLabel,
    isPending,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    title: string;
    message: ReactNode;
    confirmLabel: string;
    isPending: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  }) =>
    open
      ? createElement(
          "div",
          { role: "dialog", "aria-label": title },
          createElement("h2", null, title),
          message,
          createElement(
            "button",
            { type: "button", disabled: isPending, onClick: onCancel },
            "Cancel",
          ),
          createElement(
            "button",
            { type: "button", disabled: isPending, onClick: onConfirm },
            confirmLabel,
          ),
        )
      : null,
  Input: ({
    fullWidth: _fullWidth,
    leftIcon: _leftIcon,
    ...props
  }: Record<string, unknown>) => createElement("input", props),
  Menu: {
    Root: Passthrough,
    Trigger: Passthrough,
    Content: Passthrough,
    Item: ({
      children,
      leftIcon,
      onSelect,
      ...props
    }: {
      children?: ReactNode;
      leftIcon?: ReactNode;
      onSelect?: () => void;
    } & Record<string, unknown>) =>
      createElement(
        "button",
        { ...props, type: "button", role: "menuitem", onClick: onSelect },
        leftIcon,
        children,
      ),
    Separator: () => createElement("hr"),
    Sub: Passthrough,
    SubTrigger: Passthrough,
    SubContent: Passthrough,
  },
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
  toast: {
    success: (message: string, options?: { description?: string }) => {
      toastSuccessCalls.push({ message, description: options?.description });
    },
    error: (message: string, options?: { description?: string }) => {
      toastErrorCalls.push({ message, description: options?.description });
    },
  },
}));

const { BrandArtifactsPage } = await import("./brand-artifacts-page");

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={["/assistant/work/brands/unassigned/artifacts"]}
      >
        <Routes>
          <Route
            path="/assistant/work/brands/:brandId/artifacts"
            element={<BrandArtifactsPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

async function openDeleteConfirmation() {
  await waitFor(() => {
    expect(screen.getByText(APP.name)).toBeTruthy();
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  return screen.getByRole("dialog", { name: "Delete app" });
}

beforeEach(() => {
  activeAssistantId = ASSISTANT_ID;
  serverApps = [APP];
  serverArtifacts = [DOCUMENT_ARTIFACT];
  deleteAppResult = async () => {
    serverApps = [];
    serverArtifacts = serverArtifacts.filter(
      (artifact) =>
        artifact.resourceType !== "app" || artifact.resourceId !== APP.id,
    );
    return { data: { success: true } };
  };
  deleteAppCalls.length = 0;
  clearAppHtmlCacheCalls.length = 0;
  captureErrorCalls.length = 0;
  toastSuccessCalls.length = 0;
  toastErrorCalls.length = 0;
  pinnedAppIds.clear();
  togglePinMock.mockClear();
  setTopBarCenterMock.mockClear();
  window.localStorage.clear();
});

afterEach(cleanup);

describe("BrandArtifactsPage app deletion", () => {
  test("offers deletion only for App cards and requires confirmation", async () => {
    renderPage();

    expect(await openDeleteConfirmation()).toBeTruthy();
    expect(screen.getAllByRole("menuitem", { name: "Delete" })).toHaveLength(1);
    expect(
      screen.getByText(/will be permanently removed/).textContent,
    ).toContain(APP.name);
    expect(deleteAppCalls).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog", { name: "Delete app" })).toBeNull();
    expect(deleteAppCalls).toHaveLength(0);
    expect(screen.getByText(APP.name)).toBeTruthy();
  });

  test("deletes within the active assistant scope and removes cached list data", async () => {
    const { queryClient } = renderPage();
    await openDeleteConfirmation();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deleteAppCalls).toHaveLength(1);
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData<{ apps: typeof serverApps }>(
          appsQueryKey(ASSISTANT_ID),
        )?.apps,
      ).toEqual([]);
    });
    await waitFor(() => {
      expect(screen.queryByText(APP.name)).toBeNull();
    });

    expect(deleteAppCalls[0]).toEqual({
      path: { assistant_id: ASSISTANT_ID, id: APP.id },
      throwOnError: true,
    });
    expect(clearAppHtmlCacheCalls).toEqual([[ASSISTANT_ID, APP.id]]);
    expect(toastSuccessCalls).toEqual([
      {
        message: "App deleted",
        description: `${APP.name} was permanently removed.`,
      },
    ]);
    expect(toastErrorCalls).toEqual([]);
  });

  test("offers deletion for registry-backed App cards", async () => {
    serverArtifacts = [DOCUMENT_ARTIFACT, APP_ARTIFACT];
    const { queryClient } = renderPage();

    await openDeleteConfirmation();
    expect(
      screen.getByRole("button", { name: `Actions for ${APP.name}` }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(deleteAppCalls).toHaveLength(1);
    });
    expect(
      queryClient
        .getQueryData<{ artifacts: typeof serverArtifacts }>([
          "artifacts",
          ASSISTANT_ID,
        ])
        ?.artifacts.some((artifact) => artifact.resourceId === APP.id),
    ).toBe(false);
  });

  test("keeps the app and a retryable confirmation when deletion fails", async () => {
    const failure = new Error("Assistant is temporarily unavailable");
    deleteAppResult = async () => Promise.reject(failure);
    const { queryClient } = renderPage();
    await openDeleteConfirmation();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(toastErrorCalls).toHaveLength(1);
      expect(screen.getByRole("alert").textContent).toContain(failure.message);
    });

    expect(screen.getByText(APP.name)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Delete app" })).toBeTruthy();
    expect(
      queryClient.getQueryData<{ apps: typeof serverApps }>(
        appsQueryKey(ASSISTANT_ID),
      )?.apps,
    ).toEqual([APP]);
    expect(clearAppHtmlCacheCalls).toEqual([]);
    expect(toastSuccessCalls).toEqual([]);
    expect(toastErrorCalls).toEqual([
      { message: "App was not deleted", description: failure.message },
    ]);
    expect(captureErrorCalls).toEqual([
      {
        error: failure,
        context: "work_app_delete",
        extra: { assistantId: ASSISTANT_ID, appId: APP.id },
      },
    ]);
  });

  test("does not evict the app when the assistant does not confirm deletion", async () => {
    deleteAppResult = async () => ({ data: { success: false } });
    const { queryClient } = renderPage();
    await openDeleteConfirmation();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(toastErrorCalls).toEqual([
        {
          message: "App was not deleted",
          description:
            "The assistant did not confirm that the app was deleted.",
        },
      ]);
    });

    expect(
      queryClient.getQueryData<{ apps: typeof serverApps }>(
        appsQueryKey(ASSISTANT_ID),
      )?.apps,
    ).toEqual([APP]);
    expect(clearAppHtmlCacheCalls).toEqual([]);
  });
});
