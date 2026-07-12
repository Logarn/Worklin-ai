import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

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
});
