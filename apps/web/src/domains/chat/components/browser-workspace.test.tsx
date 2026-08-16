import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const submitSurfaceAction = mock(async () => ({ ok: true as const }));

mock.module("@/domains/chat/api/surfaces", () => ({
  submitSurfaceAction,
}));

import { BrowserWorkspace } from "@/domains/chat/components/browser-workspace";
import { useStreamStore } from "@/domains/chat/stream-store";
import { INITIAL_TURN_STATE, useTurnStore } from "@/domains/chat/turn-store";
import type { OpenedBrowserState } from "@/stores/viewer-store";

const browser: OpenedBrowserState = {
  surfaceId: "browser-surface",
  data: {
    url: "https://example.com/",
    title: "Example",
    status: "ready",
    connectionLabel: "Worklin browser",
    updatedAt: 123,
    activity: [
      {
        id: "step-1",
        label: "Opened a page",
        status: "completed",
        timestamp: 123,
      },
    ],
  },
};

beforeEach(() => {
  submitSurfaceAction.mockClear();
  submitSurfaceAction.mockImplementation(async () => ({ ok: true as const }));
  useTurnStore.setState(INITIAL_TURN_STATE);
  useStreamStore.setState({
    stream: null,
    streamEpoch: 0,
    streamContext: {
      assistantId: "assistant-1",
      conversationId: "conversation-1",
    },
  });
});

afterEach(cleanup);

describe("BrowserWorkspace", () => {
  test("sends an address-bar navigation through the active Worklin conversation", async () => {
    render(<BrowserWorkspace browser={browser} onClose={() => {}} />);

    const address = screen.getByLabelText("Website address");
    fireEvent.change(address, { target: { value: "example.org/launch" } });
    fireEvent.submit(address.closest("form")!);

    await waitFor(() => expect(submitSurfaceAction).toHaveBeenCalledTimes(1));
    expect(submitSurfaceAction).toHaveBeenCalledWith(
      "assistant-1",
      "browser-surface",
      "agent_prompt",
      {
        prompt:
          "Open https://example.org/launch in the browser and continue the current task.",
      },
    );
    expect(useTurnStore.getState().phase).toBe("thinking");
  });

  test("shows a useful error instead of dropping commands without a live session", async () => {
    useStreamStore.setState({ streamContext: null });
    render(<BrowserWorkspace browser={browser} onClose={() => {}} />);

    fireEvent.click(screen.getByLabelText("Refresh"));

    expect(
      await screen.findByText(
        "The browser session is not connected. Please try again.",
      ),
    ).toBeTruthy();
    expect(submitSurfaceAction).not.toHaveBeenCalled();
  });

  test("shows browser activity in newest-first order", () => {
    render(
      <BrowserWorkspace
        browser={{
          ...browser,
          data: {
            ...browser.data,
            activity: [
              ...browser.data.activity,
              {
                id: "step-2",
                label: "Saved the form",
                status: "completed",
                timestamp: 456,
              },
            ],
          },
        }}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByText("Activity"));
    const activityText = screen.getByText("Saved the form");
    const earlierText = screen.getByText("Opened a page");
    expect(
      activityText.compareDocumentPosition(earlierText) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
