export interface ConversationSuggestionState {
  suggestionCache: Map<string, string>;
  suggestionInFlight: Map<string, Promise<string | null>>;
}

const productionState: ConversationSuggestionState = {
  suggestionCache: new Map(),
  suggestionInFlight: new Map(),
};

export function getConversationSuggestionState(): ConversationSuggestionState {
  return productionState;
}

/**
 * Clear process-local reply suggestions before a pooled worker is assigned to
 * another tenant. The drain fence proves there are no active requests first,
 * so no in-flight generator can repopulate these maps after the reset.
 */
export function resetConversationSuggestionStateForTenantAssignment(): void {
  productionState.suggestionCache.clear();
  productionState.suggestionInFlight.clear();
}
