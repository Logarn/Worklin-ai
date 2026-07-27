import { describe, expect, mock, test } from "bun:test";

import {
  createActiveRequestPolledObservation,
  stopMatchingRequestPolledObservation,
  suppressRequestPolledObservation,
} from "./request-polled-turn";

describe("active request-polled observation", () => {
  test("stops the visible turn and returns its resolved cancellation id", () => {
    const stopObservation = mock(() => {});
    const observation = createActiveRequestPolledObservation({
      assistantId: "assistant-1",
      requestConversationId: "draft-1",
      turnId: "turn-1",
      stopObservation,
    });
    observation.resolvedConversationId = "conversation-1";

    expect(
      stopMatchingRequestPolledObservation(
        observation,
        "assistant-1",
        "draft-1",
      ),
    ).toBe("conversation-1");
    expect(observation.resultSuppressed).toBe(true);
    expect(stopObservation).toHaveBeenCalledTimes(1);
  });

  test("does not stop an observer owned by another chat scope", () => {
    const stopObservation = mock(() => {});
    const observation = createActiveRequestPolledObservation({
      assistantId: "assistant-1",
      requestConversationId: "conversation-1",
      turnId: "turn-1",
      stopObservation,
    });

    expect(
      stopMatchingRequestPolledObservation(
        observation,
        "assistant-1",
        "conversation-2",
      ),
    ).toBeNull();
    expect(observation.resultSuppressed).toBe(false);
    expect(stopObservation).not.toHaveBeenCalled();
  });

  test("scope cleanup suppresses late timeout and connection results", () => {
    const stopObservation = mock(() => {});
    const observation = createActiveRequestPolledObservation({
      assistantId: "assistant-1",
      requestConversationId: "conversation-1",
      turnId: "turn-1",
      stopObservation,
    });

    suppressRequestPolledObservation(observation);

    expect(observation.resultSuppressed).toBe(true);
    expect(stopObservation).toHaveBeenCalledTimes(1);
  });
});
