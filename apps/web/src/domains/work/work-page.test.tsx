import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from "react-router";

const setActiveConversationIdMock = mock((_id: string) => {});
const setMainViewMock = mock((_view: string) => {});

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));
mock.module("@/components/layout/chat-layout-slots-store", () => ({
  useChatLayoutSlotsStore: {
    use: { setTopBarCenter: () => mock((_value: unknown) => {}) },
  },
}));
mock.module("@/components/brand-research-status", () => ({
  BrandResearchStatus: () => null,
}));
mock.module("@/domains/work/use-work-data", () => ({
  useWorkData: () => ({
    brands: [],
    isLoading: false,
    hasPartialError: false,
  }),
}));
mock.module("@/stores/conversation-store", () => ({
  useConversationStore: {
    getState: () => ({
      setActiveConversationId: setActiveConversationIdMock,
    }),
  },
}));
mock.module("@/stores/viewer-store", () => ({
  useViewerStore: {
    getState: () => ({ setMainView: setMainViewMock }),
  },
}));
mock.module("@/utils/conversation-selection", () => ({
  createDraftConversationId: () => "draft-work-test",
}));

const { WorkPage } = await import("./work-page");

function LocationProbe() {
  const location = useLocation();
  return (
    <output
      data-testid="location"
      data-pathname={location.pathname}
      data-search={location.search}
    />
  );
}

describe("WorkPage", () => {
  afterEach(() => {
    cleanup();
    setActiveConversationIdMock.mockClear();
    setMainViewMock.mockClear();
  });

  test("lets a user with no brands start creating with Worklin", async () => {
    render(
      <MemoryRouter initialEntries={["/assistant/work"]}>
        <LocationProbe />
        <Routes>
          <Route path="/assistant/work" element={<WorkPage />} />
          <Route path="/assistant/conversations/:conversationId" element={null} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Create with Worklin" }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("location").dataset.pathname).toBe(
        "/assistant/conversations/draft-work-test",
      );
    });
    expect(setActiveConversationIdMock).toHaveBeenCalledWith(
      "draft-work-test",
    );
    expect(setMainViewMock).toHaveBeenCalledWith("chat");

    const search = new URLSearchParams(
      screen.getByTestId("location").dataset.search,
    );
    expect(search.get("prompt")).toContain("right brand");
  });
});
