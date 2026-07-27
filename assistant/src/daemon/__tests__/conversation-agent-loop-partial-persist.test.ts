import { describe, expect, test } from "bun:test";

import {
  createEventHandlerState,
  settlePendingPartialPersistOnExit,
} from "../conversation-agent-loop-handlers.js";

describe("pooled conversation partial-persist cleanup", () => {
  test("cancels a queued flush and awaits a flush already in flight", async () => {
    const state = createEventHandlerState();
    let timerFired = false;
    state.pendingPartialFlushTimer = setTimeout(() => {
      timerFired = true;
    }, 0);

    let release!: () => void;
    state.pendingPartialFlushPromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    const settling = settlePendingPartialPersistOnExit(state);
    await Promise.resolve();
    expect(timerFired).toBe(false);

    release();
    await settling;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(timerFired).toBe(false);
    expect(state.pendingPartialFlushTimer).toBeUndefined();
    expect(state.pendingPartialFlushPromise).toBeUndefined();
  });
});
