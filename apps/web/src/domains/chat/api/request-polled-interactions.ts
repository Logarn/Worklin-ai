/**
 * Restores approval prompts discovered by bounded pooled-runtime polling.
 *
 * This is deliberately display-only. It writes the existing interaction and
 * transcript stores so the normal authenticated Allow / Deny action remains
 * the only path that can resolve a permission request.
 */

import { getPendingInteractions } from "@/domains/chat/api/interactions";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useTurnStore } from "@/domains/chat/turn-store";
import {
  parsePendingConfirmationData,
  parsePendingSecretState,
} from "@/domains/chat/utils/send-message-utils";
import { attachConfirmationToToolCall } from "@/domains/chat/utils/chat";

export async function restoreRequestPolledInteractions({
  assistantId,
  conversationId,
  isCurrent,
}: {
  assistantId: string;
  conversationId: string;
  isCurrent: () => boolean;
}): Promise<boolean> {
  try {
    const interactions = await getPendingInteractions(
      assistantId,
      conversationId,
    );
    if (!isCurrent()) return false;

    let restored = false;
    if (interactions.pendingSecret) {
      useInteractionStore
        .getState()
        .showSecret(parsePendingSecretState(interactions.pendingSecret));
      useTurnStore.getState().onSecretRequest();
      restored = true;
    } else if (useInteractionStore.getState().pendingSecret) {
      useInteractionStore.getState().dismissSecret();
    }
    if (interactions.pendingConfirmation) {
      const { confData, state } = parsePendingConfirmationData(
        interactions.pendingConfirmation,
      );
      useInteractionStore.getState().showConfirmation(state);
      useTurnStore.getState().onConfirmationRequest();
      restored = true;

      const currentMessages = useChatSessionStore.getState().messages;
      const result = attachConfirmationToToolCall(currentMessages, confData);
      if (result.attachedToolCallId) {
        useInteractionStore
          .getState()
          .setInlineConfirmationToolCallId(result.attachedToolCallId);
        useChatSessionStore
          .getState()
          .setConfirmationToolCall(
            confData.requestId,
            result.attachedToolCallId,
          );
      } else {
        useInteractionStore.getState().setInlineConfirmationToolCallId(null);
      }
      useChatSessionStore.getState().setMessages(() => result.updatedMessages);
    } else if (useInteractionStore.getState().pendingConfirmation) {
      useInteractionStore.getState().dismissConfirmation();
      useInteractionStore.getState().setInlineConfirmationToolCallId(null);
    }
    return restored;
  } catch {
    // Best-effort. The next bounded snapshot retries while the turn is active.
    return false;
  }
}
