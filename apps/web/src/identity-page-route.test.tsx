import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { IdentityGetResponse } from "@/generated/daemon/types.gen";
import { assistantIdentityQueryKey } from "@/lib/sync/query-tags";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const assistantAIdentity: IdentityGetResponse = {
  name: "Assistant A",
  role: "Original A role",
  personality: "Focused",
  emoji: ":sparkles:",
  home: "",
  version: "0.8.12",
};

const assistantBIdentity: IdentityGetResponse = {
  name: "Assistant B",
  role: "Current B role",
  personality: "Curious",
  emoji: ":wave:",
  home: "",
  version: "0.9.0",
};

const savedAssistantAIdentity: IdentityGetResponse = {
  ...assistantAIdentity,
  role: "Saved A role",
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const updateAssistantIdentity = mock(
  async (): Promise<IdentityGetResponse> => savedAssistantAIdentity,
);

mock.module("@/assistant/api", () => ({
  getAssistant: async (assistantId: string) => ({
    ok: true,
    data: {
      created:
        assistantId === "assistant-a"
          ? "2026-01-01T00:00:00.000Z"
          : "2026-02-01T00:00:00.000Z",
    },
  }),
}));

mock.module("@/assistant/identity", () => ({
  fetchAssistantIdentity: async (assistantId: string) =>
    assistantId === "assistant-a" ? assistantAIdentity : assistantBIdentity,
  updateAssistantIdentity,
}));

mock.module("@/assistant/lifecycle-store", () => ({
  useAssistantLifecycleStore: {
    use: {
      assistantState: () => ({ kind: "checking" }),
    },
  },
}));

mock.module("@/stores/client-feature-flag-store", () => ({
  useClientFeatureFlagStore: {
    use: {
      selfHostedAssistant: () => false,
    },
  },
}));

mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: () => ({
    components: null,
    traits: null,
    customImageUrl: null,
    characterProfile: null,
    isLoading: false,
    invalidate: () => {},
  }),
}));

mock.module("@/components/avatar/chat-avatar", () => ({
  ChatAvatar: () => <div data-testid="chat-avatar" />,
}));

mock.module("@/components/avatar/avatar-management-modal", () => ({
  AvatarManagementModal: () => null,
}));

mock.module(
  "@/domains/intelligence/components/constellation-view/constellation-view",
  () => ({
    ConstellationView: () => <div data-testid="constellation" />,
  }),
);

mock.module("@/domains/intelligence/skills/install", () => ({
  installSkill: async () => {},
}));

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  skillsGetOptions: ({ path }: { path: { assistant_id: string } }) => ({
    queryKey: ["skills", path.assistant_id],
    queryFn: async () => ({ skills: [] }),
  }),
  skillsGetQueryKey: ({ path }: { path: { assistant_id: string } }) => [
    "skills",
    path.assistant_id,
  ],
  useSkillsByIdDeleteMutation: () => ({ mutate: () => {} }),
}));

mock.module("@/stores/conversation-store", () => ({
  useConversationStore: { getState: () => ({}) },
}));

mock.module("@/stores/viewer-store", () => ({
  useViewerStore: { getState: () => ({}) },
}));

const { IdentityPageRoute } = await import("@/identity-page-route");

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    assistantIdentityQueryKey("assistant-a"),
    assistantAIdentity,
  );
  queryClient.setQueryData(
    assistantIdentityQueryKey("assistant-b"),
    assistantBIdentity,
  );
  useResolvedAssistantsStore.setState({ activeAssistantId: "assistant-a" });
  useAssistantIdentityStore
    .getState()
    .setIdentity(assistantAIdentity.name, assistantAIdentity.version);
  updateAssistantIdentity.mockClear();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("IdentityPageRoute", () => {
  test("a late save for A after the route remounts to B updates only A's cache", async () => {
    const deferred = createDeferred<IdentityGetResponse>();
    updateAssistantIdentity.mockImplementationOnce(() => deferred.promise);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <IdentityPageRoute />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText("Original A role");
    fireEvent.click(screen.getByRole("button", { name: "Edit role" }));
    fireEvent.change(screen.getByLabelText("Role"), {
      target: { value: "Saved A role" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateAssistantIdentity).toHaveBeenCalledWith("assistant-a", {
        role: "Saved A role",
      });
    });

    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity(assistantBIdentity.name, assistantBIdentity.version);
      useResolvedAssistantsStore.setState({
        activeAssistantId: "assistant-b",
      });
    });

    await screen.findByText("Current B role");
    expect(screen.queryByRole("dialog", { name: "Edit role" })).toBeNull();

    await act(async () => {
      deferred.resolve(savedAssistantAIdentity);
      await deferred.promise;
      await Promise.resolve();
    });

    expect(
      queryClient.getQueryData<IdentityGetResponse>(
        assistantIdentityQueryKey("assistant-a"),
      ),
    ).toEqual(savedAssistantAIdentity);
    expect(
      queryClient.getQueryData<IdentityGetResponse>(
        assistantIdentityQueryKey("assistant-b"),
      ),
    ).toEqual(assistantBIdentity);
    expect(useAssistantIdentityStore.getState()).toMatchObject({
      name: "Assistant B",
      version: "0.9.0",
    });
  });
});
