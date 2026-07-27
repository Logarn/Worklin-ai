/**
 * Starts a request-pinned agent turn and its bounded transcript observer at
 * the same time.
 *
 * Pooled workers cannot keep an assistant-wide SSE request open while idle.
 * Their message POST therefore remains open for the lifetime of the agent
 * turn, while this observer uses short `/messages` reads to surface persisted
 * progress and approval prompts. Keeping the two promises explicit lets the
 * caller stop the observer on an HTTP rejection without coupling transcript
 * delivery to the POST response.
 */

export interface RequestPolledTurn<TPost, TObservation> {
  postResult: Promise<TPost>;
  observation: Promise<TObservation>;
  stopObservation: () => void;
}

/**
 * UI-owned handle for the one bounded observer attached to a pooled turn.
 *
 * The long-running message POST and the transcript observer are intentionally
 * separate requests. Keeping this handle outside the send callback lets Stop
 * Generation and conversation-scope cleanup abort the observer even while the
 * POST is still awaiting the assistant.
 */
export interface ActiveRequestPolledObservation {
  assistantId: string;
  requestConversationId: string;
  resolvedConversationId: string | null;
  turnId: string;
  resultSuppressed: boolean;
  stopObservation: () => void;
}

export function createActiveRequestPolledObservation({
  assistantId,
  requestConversationId,
  turnId,
  stopObservation,
}: {
  assistantId: string;
  requestConversationId: string;
  turnId: string;
  stopObservation: () => void;
}): ActiveRequestPolledObservation {
  return {
    assistantId,
    requestConversationId,
    resolvedConversationId: null,
    turnId,
    resultSuppressed: false,
    stopObservation,
  };
}

export function suppressRequestPolledObservation(
  observation: ActiveRequestPolledObservation,
): void {
  observation.resultSuppressed = true;
  observation.stopObservation();
}

/**
 * Stop the active observer only when it belongs to the visible chat scope.
 * Returns the authoritative conversation id that should receive the backend
 * cancellation request. First-message pooled turns begin under a draft key,
 * so the resolved id learned from polling takes precedence when available.
 */
export function stopMatchingRequestPolledObservation(
  observation: ActiveRequestPolledObservation | null,
  assistantId: string,
  conversationId: string,
): string | null {
  if (
    !observation ||
    observation.assistantId !== assistantId ||
    (observation.requestConversationId !== conversationId &&
      observation.resolvedConversationId !== conversationId)
  ) {
    return null;
  }

  suppressRequestPolledObservation(observation);
  return observation.resolvedConversationId ?? observation.requestConversationId;
}

export function beginRequestPolledTurn<TPost, TObservation>({
  post,
  observe,
}: {
  post: () => Promise<TPost>;
  observe: (signal: AbortSignal) => Promise<TObservation>;
}): RequestPolledTurn<TPost, TObservation> {
  const controller = new AbortController();
  const postResult = post().catch((error) => {
    controller.abort();
    throw error;
  });
  let observation: Promise<TObservation>;
  try {
    observation = observe(controller.signal);
  } catch (error) {
    controller.abort();
    void postResult.catch(() => undefined);
    throw error;
  }
  // The caller commonly awaits the request-pinned POST before attaching its
  // terminal observer handlers. Mark an early polling rejection as observed
  // immediately; the original promise still rejects for the caller's handler.
  void observation.catch(() => undefined);

  return {
    postResult,
    observation,
    stopObservation: () => controller.abort(),
  };
}
