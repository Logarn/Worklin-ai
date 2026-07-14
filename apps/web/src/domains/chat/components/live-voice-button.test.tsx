/**
 * Tests for `LiveVoiceButton`.
 *
 * The button is gated behind the `voice-mode` assistant flag and toggles a
 * {@link useLiveVoice} session. We mock both so the component renders in
 * isolation: the flag store via a mutable `mockVoiceMode`, and `useLiveVoice`
 * via spies for `start`/`stop` plus a mutable `mockState`/`mockInputAmplitude`.
 *
 * Uses happy-dom via the bun:test preload configured in `web/bunfig.toml`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";

import type { LiveVoiceSessionState } from "@/domains/chat/voice/live-voice/live-voice-store";

let mockVoiceMode = false;
mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    use: {
      voiceMode: () => mockVoiceMode,
    },
  },
}));

const startSpy = mock(
  async (_assistantId: string, _conversationId?: string) => {},
);
const stopSpy = mock(async () => {});
let mockState: LiveVoiceSessionState = "idle";
let mockInputAmplitude = 0;
mock.module("@/domains/chat/voice/live-voice/use-live-voice", () => ({
  useLiveVoice: () => ({
    state: mockState,
    partialTranscript: "",
    finalTranscript: "",
    assistantTranscript: "",
    inputAmplitude: mockInputAmplitude,
    outputAmplitude: 0,
    muted: false,
    error: null,
    start: startSpy,
    stop: stopSpy,
    toggleMute: () => {},
  }),
}));

// Imported after the mocks so the component picks up the mocked modules.
const { LiveVoiceButton } =
  await import("@/domains/chat/components/live-voice-button");
type LiveVoiceButtonHandle =
  import("@/domains/chat/components/live-voice-button").LiveVoiceButtonHandle;

beforeEach(() => {
  mockVoiceMode = false;
  mockState = "idle";
  mockInputAmplitude = 0;
  startSpy.mockClear();
  stopSpy.mockClear();
  window.localStorage.setItem("worklin.voice-disclosure.v1", "accepted");
});

afterEach(() => {
  cleanup();
});

describe("LiveVoiceButton", () => {
  test("renders nothing when the voice-mode flag is off", () => {
    // GIVEN the voice-mode flag is disabled
    mockVoiceMode = false;

    // WHEN the button renders
    const { container } = render(<LiveVoiceButton assistantId="a1" />);

    // THEN nothing is painted
    expect(container.firstChild).toBeNull();
  });

  test("renders no competing compact control while the voice card is open", () => {
    mockVoiceMode = true;
    mockState = "idle";

    const { container } = render(<LiveVoiceButton assistantId="a1" />);

    expect(container.firstChild).toBeNull();
  });

  test("the compact orb reopens the card without starting a provider session", () => {
    mockVoiceMode = true;
    mockState = "idle";
    const onOpenPanel = mock(() => {});
    const { getByLabelText } = render(
      <LiveVoiceButton
        assistantId="a1"
        conversationId="c1"
        panelOpen={false}
        onOpenPanel={onOpenPanel}
      />,
    );

    fireEvent.click(getByLabelText("Show live voice"));

    expect(onOpenPanel).toHaveBeenCalledTimes(1);
    expect(startSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  test("starts only through the explicit card action", () => {
    mockVoiceMode = true;
    mockState = "idle";
    const ref = createRef<LiveVoiceButtonHandle>();
    render(
      <LiveVoiceButton
        ref={ref}
        assistantId="a1"
        conversationId="c1"
      />,
    );

    ref.current?.start();

    expect(startSpy).toHaveBeenCalledWith("a1", "c1");
  });

  test("stops the session on click when active", () => {
    // GIVEN an active session (listening)
    mockVoiceMode = true;
    mockState = "listening";
    const { getByLabelText } = render(
      <LiveVoiceButton assistantId="a1" panelOpen={false} />,
    );

    // THEN the control reflects the live session
    const button = getByLabelText("Stop voice mode");
    expect(button.getAttribute("aria-pressed")).toBe("true");

    // WHEN the user clicks it
    fireEvent.click(button);

    // THEN it stops the session
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).not.toHaveBeenCalled();
  });

  test("reflects connecting as a busy, non-toggling state", () => {
    // GIVEN a session that is still connecting
    mockVoiceMode = true;
    mockState = "connecting";
    const { getByLabelText } = render(
      <LiveVoiceButton assistantId="a1" panelOpen={false} />,
    );

    // THEN the control is busy and disabled
    const button = getByLabelText("Connecting live voice") as HTMLButtonElement;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(true);

    // WHEN the user clicks it, neither start nor stop fire
    fireEvent.click(button);
    expect(startSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  test("stays stoppable when disabled while a session is active", () => {
    // GIVEN an active session and a parent that has raised `disabled`
    mockVoiceMode = true;
    mockState = "listening";
    const { getByLabelText } = render(
      <LiveVoiceButton assistantId="a1" disabled panelOpen={false} />,
    );

    // THEN the stop control remains enabled despite the external disabled prop
    const button = getByLabelText("Stop voice mode") as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    // WHEN the user clicks it, the session is stopped
    fireEvent.click(button);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).not.toHaveBeenCalled();
  });

  test("prevents starting a session when disabled while idle", () => {
    // GIVEN an idle, flag-enabled button that the parent has disabled
    mockVoiceMode = true;
    mockState = "idle";
    const { getByLabelText } = render(
      <LiveVoiceButton assistantId="a1" disabled panelOpen={false} />,
    );

    // THEN the reopen control is disabled
    const button = getByLabelText("Show live voice") as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    // WHEN the user clicks it, no session is started
    fireEvent.click(button);
    expect(startSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  test("scales the icon with live amplitude while active", () => {
    // GIVEN an active session with non-zero mic amplitude
    mockVoiceMode = true;
    mockState = "listening";
    mockInputAmplitude = 1;
    const { getByLabelText } = render(
      <LiveVoiceButton assistantId="a1" panelOpen={false} />,
    );

    // THEN the control carries an amplitude-driven transform
    const button = getByLabelText("Stop voice mode");
    expect(button.style.transform).toContain("scale(");
  });
});
