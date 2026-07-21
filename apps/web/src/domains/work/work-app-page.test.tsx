import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

const APP = {
  appId: "app-1",
  dirName: "app-1",
  name: "Launch Calculator",
  html: "<main>Calculator</main>",
};

const openAppMock = mock((_options: unknown) =>
  Promise.resolve({ data: APP }),
);
const primeAppHtmlCacheMock = mock((..._args: unknown[]) => {});

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));
mock.module("@/generated/daemon/sdk.gen", () => ({
  appsByIdOpenPost: openAppMock,
}));
mock.module("@/utils/app-html-cache", () => ({
  primeAppHtmlCache: primeAppHtmlCacheMock,
}));
mock.module("@/hooks/use-edit-app", () => ({
  useEditApp: () => mock(() => {}),
}));
mock.module("@/utils/share-app", () => ({
  shareApp: mock(async () => {}),
}));
mock.module("@/components/app-viewer-container", () => ({
  AppViewerContainer: ({ appName }: { appName: string }) => (
    <div data-testid="app-viewer">{appName}</div>
  ),
}));

const { WorkAppPage } = await import("./work-app-page");

function renderAppPage(
  path = "/assistant/work/brands/unassigned/artifacts/apps/app-1",
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/assistant/work/brands/:brandId/artifacts/apps/:appId"
          element={<WorkAppPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("WorkAppPage", () => {
  beforeEach(() => {
    openAppMock.mockReset();
    primeAppHtmlCacheMock.mockClear();
  });

  afterEach(cleanup);

  test("shows a meaningful loading state while the app is opening", () => {
    openAppMock.mockImplementation(
      () => new Promise<{ data: typeof APP }>(() => {}),
    );

    renderAppPage();

    expect(screen.getByRole("status").textContent).toContain("Opening app");
  });

  test("renders the app after loading succeeds", async () => {
    openAppMock.mockResolvedValue({ data: APP });

    renderAppPage();

    await waitFor(() => {
      expect(screen.getByTestId("app-viewer").textContent).toBe(
        "Launch Calculator",
      );
    });
    expect(primeAppHtmlCacheMock).toHaveBeenCalledWith(
      "assistant-1",
      "app-1",
      APP.html,
    );
  });

  test("offers a retry instead of leaving a failed app route blank", async () => {
    openAppMock
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce({ data: APP });

    renderAppPage();

    await waitFor(() => {
      expect(screen.getByText("App could not open")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(screen.getByTestId("app-viewer")).toBeTruthy();
    });
    expect(openAppMock).toHaveBeenCalledTimes(2);
  });
});
