import { afterEach, describe, expect, test } from "bun:test";

import {
  getConversationSuggestionState,
  resetConversationSuggestionStateForTenantAssignment,
} from "../conversation-suggestion-cache.js";

afterEach(() => {
  resetConversationSuggestionStateForTenantAssignment();
});

describe("conversation suggestion cache tenant reset", () => {
  test("clears cached and in-flight tenant values together", () => {
    const state = getConversationSuggestionState();
    state.suggestionCache.set("shared-message-id", "tenant-one suggestion");
    state.suggestionInFlight.set(
      "shared-message-id",
      Promise.resolve("tenant-one pending suggestion"),
    );

    resetConversationSuggestionStateForTenantAssignment();

    expect(state.suggestionCache.size).toBe(0);
    expect(state.suggestionInFlight.size).toBe(0);
  });
});
