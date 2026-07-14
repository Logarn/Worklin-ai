import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { mock } from "bun:test";

import { VoiceConversationPanel } from "./voice-conversation-panel";

afterEach(cleanup);

describe("VoiceConversationPanel", () => {
  test("uses microphone amplitude while listening and playback amplitude while speaking", () => {
    const view = render(
      <VoiceConversationPanel
        state="listening"
        inputAmplitude={0.8}
        outputAmplitude={0}
      />,
    );
    const listeningHeight =
      view.container.querySelectorAll("span")[4]?.style.height;

    view.rerender(
      <VoiceConversationPanel
        state="speaking"
        inputAmplitude={0}
        outputAmplitude={0.9}
      />,
    );
    const speakingHeight =
      view.container.querySelectorAll("span")[4]?.style.height;

    expect(Number.parseFloat(listeningHeight ?? "0")).toBeGreaterThan(5);
    expect(Number.parseFloat(speakingHeight ?? "0")).toBeGreaterThan(5);
    expect(view.getByText("Worklin is speaking")).toBeTruthy();
  });

  test("keeps textual labels and reduced-motion fallbacks for every animation", () => {
    const { container, getByText } = render(
      <VoiceConversationPanel
        state="thinking"
        assistantTranscript="One moment"
      />,
    );
    expect(getByText("Thinking")).toBeTruthy();
    expect(getByText("One moment")).toBeTruthy();
    expect(container.innerHTML).toContain("motion-reduce:animate-none");
    expect(container.innerHTML).toContain("motion-reduce:transition-none");
  });

  test("keeps royal blue as the only visualization accent", () => {
    const { container } = render(
      <VoiceConversationPanel state="speaking" outputAmplitude={0.8} />,
    );
    expect(container.innerHTML).toContain("#4169e1");
    expect(container.innerHTML).toContain("#9ab2ff");
    expect(container.innerHTML).not.toContain("violet");
    expect(container.innerHTML).not.toContain("fuchsia");
  });

  test("keeps the ready surface visible before a session starts", () => {
    const { getByText } = render(<VoiceConversationPanel state="idle" />);

    expect(getByText("Ready")).toBeTruthy();
    expect(getByText("Click the orb to start live voice.")).toBeTruthy();
    expect(
      getByText("Your microphone and voice provider connect only after you click."),
    ).toBeTruthy();
  });

  test("makes the large orb the explicit start control", () => {
    const onStart = mock(() => {});
    const { getByLabelText } = render(
      <VoiceConversationPanel state="idle" onStart={onStart} />,
    );

    fireEvent.click(getByLabelText("Start live voice"));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  test("provides a close affordance with safe state-specific labeling", () => {
    const onClose = mock(() => {});
    const view = render(
      <VoiceConversationPanel state="idle" onClose={onClose} />,
    );

    fireEvent.click(view.getByLabelText("Hide live voice"));
    expect(onClose).toHaveBeenCalledTimes(1);

    view.rerender(
      <VoiceConversationPanel state="listening" onClose={onClose} />,
    );
    expect(view.getByLabelText("End and hide live voice")).toBeTruthy();
  });
});
