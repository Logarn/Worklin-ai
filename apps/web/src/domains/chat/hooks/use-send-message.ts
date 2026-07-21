/**
 * Handles sending user messages, managing the stream lifecycle, and
 * queue operations (cancel, delete, edit).
 *
 * Orchestrates: optimistic message insertion, draft key resolution,
 * stream creation via `postChatMessage`/`pollForResponse`, and
 * processing-key tracking.
 *
 * Composes `useMessageQueue` for queue management and imports pure
 * transforms from `send-message-utils`.
 */

import { captureError } from "@/lib/sentry/capture-error";
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { routes } from "@/utils/routes";

import type {
  DisplayAttachment,
  DisplayMessage,
} from "@/domains/chat/types/types";
import { reconcileSnapshot } from "@/domains/chat/utils/reconcile-snapshot";
import { getLocalSeq, recordLocalSeq } from "@/lib/streaming/local-seq";
import { isAsyncChatScopeCurrent } from "@/domains/chat/utils/conversation-scope";
import { resolveEditChatDraftConversationId } from "@/utils/edit-chat-session";
import {
  type DiskPressureChatBlockReason,
  getDiskPressureChatBlockMessage,
} from "@/assistant/disk-pressure";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useStreamStore } from "@/domains/chat/stream-store";
import {
  useResolvedAssistantsStore,
  usesPooledRequestPolling,
} from "@/stores/resolved-assistants-store";
import { recordDiagnostic } from "@/lib/diagnostics";
import { saveDismissedSurfaceIds } from "@/domains/chat/utils/dismissed-surfaces-storage";
import { isSending, useTurnStore } from "@/domains/chat/turn-store";
import { endTurn } from "@/domains/chat/turn-coordinator";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useConversationStore } from "@/stores/conversation-store";
import {
  prependConversation,
  removeConversation,
  resolveDraftKey,
  shouldSurfaceConversationOnUserSend,
  surfaceConversationInCaches,
} from "@/utils/conversation-cache-mutations";
import {
  findConversation,
  patchConversation,
} from "@/utils/conversation-cache";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import {
  consumePendingPreChatContext,
  type PreChatOnboardingContext,
} from "@/domains/onboarding/prechat";

import { clearQueueStatus } from "@/domains/chat/utils/stream-updaters/shared";
import { mapRuntimeToDisplayMessage } from "@/domains/chat/utils/map-runtime-message";
import type { ChatError } from "@/domains/chat/types";

import {
  clearPendingConfirmationsFromMessages,
  dismissInteractiveSurfaces,
  newTurnId,
  resolvePostError,
} from "@/domains/chat/utils/send-message-utils";
import { useComposerStore } from "@/domains/chat/composer-store";
import { useMessageQueue } from "@/domains/chat/hooks/use-message-queue";
import { conversationsByIdCancelPost } from "@/generated/daemon/sdk.gen";
import { configGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { Conversation } from "@/types/conversation-types";
import {
  fetchConversationMessages,
  POOLED_REQUEST_POLL_TIMEOUT_MS,
  postChatMessage,
  pollForResponse,
} from "@/domains/chat/api/messages";
import {
  beginRequestPolledTurn,
  createActiveRequestPolledObservation,
  stopMatchingRequestPolledObservation,
  suppressRequestPolledObservation,
  type ActiveRequestPolledObservation,
} from "@/domains/chat/api/request-polled-turn";
import { restoreRequestPolledInteractions } from "@/domains/chat/api/request-polled-interactions";
import { surfaceConversation } from "@/domains/chat/api/conversations";
import type { ConversationMessage } from "@vellumai/assistant-api";
import { supportsServerMintedConversation } from "@/lib/backwards-compat/server-minted-conversation";
import { isDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import {
  ConversationNotFoundError,
  fetchConversationDetail,
} from "@/utils/fetch-conversation-detail";
import { ensureRunnableProfileFromStoredConnection } from "@/assistant/provider-profile-repair";
import { shouldAttemptProviderProfileRepair } from "@/domains/chat/utils/provider-profile-repair-trigger";

// ---------------------------------------------------------------------------
// Stream send result
// ---------------------------------------------------------------------------

/**
 * Tagged result of `sendMessageViaStream`. Surfaced to the caller so it can
 * differentiate clean success, in-flight scope changes (ignore), and POST
 * failures (which require optimistic-state rollback).
 *
 * Previously the hook returned `string | undefined` and called `setError`
 * directly, which made it impossible for the caller to roll back the
 * optimistic user-message bubble or remove the just-prepended draft
 * conversation from the sidebar.
 */
type SendStreamResult =
  | {
      status: "ok";
      resolvedConversationId?: string;
      /** Server-assigned user message id from the active POST resolve.
       *  Absent for the queued path (POST returns only `requestId`) and
       *  for scope-changed-mid-flight results. Used by `sendMessage` to
       *  swap the optimistic user row's client id for the server id and
       *  clear `isOptimistic`. */
      userMessageId?: string;
    }
  | { status: "ignored" }
  | { status: "failed"; error: ChatError };

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

interface UseSendMessageParams {
  // Identity
  assistantId: string | null;
  activeConversationId: string | null;
  diskPressureChatBlockReason: DiskPressureChatBlockReason | null;
  messages: DisplayMessage[];

  // Onboarding refs (ChatPage-local, not per-conversation)
  pendingOnboardingContextRef: MutableRefObject<PreChatOnboardingContext | null>;
  onboardingDraftConversationIdRef: MutableRefObject<string | null>;

  // Callbacks
  startReconciliationLoop: (epoch: number) => void;
  cancelReconciliation: () => void;
  refreshConversations: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSendMessage({
  assistantId,
  activeConversationId,
  diskPressureChatBlockReason,
  messages,
  pendingOnboardingContextRef,
  onboardingDraftConversationIdRef,
  startReconciliationLoop,
  cancelReconciliation,
  refreshConversations,
}: UseSendMessageParams) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setMessages = useChatSessionStore.use.setMessages();
  const setError = useChatSessionStore.use.setError();

  // -------------------------------------------------------------------------
  // Server-mint in-flight gate
  // -------------------------------------------------------------------------
  // Holds the draft id of an in-flight first-message POST. Dedicated
  // assistants use the server-mint flow; pooled assistants use a stable
  // conversationKey so bounded polling can observe the turn before the POST
  // resolves. While set, `sendMessage` refuses a second send because the
  // authoritative internal id is not available to the queue path yet.
  //
  // Without this gate, a follow-up send during the window would post
  // the local draft key to a 0.8.6+ assistant's strict-lookup endpoint
  // and 404 (the assistant minted a different id).
  //
  // Cleared after the POST resolves or rejects. The draft-id check on
  // clear guards against re-mounts overwriting a newer mint.
  const pendingDraftMintRef = useRef<string | null>(null);
  const surfacingConversationIdsRef = useRef<Set<string>>(new Set());
  const activeRequestPolledObservationRef =
    useRef<ActiveRequestPolledObservation | null>(null);

  // A pooled observer is scoped to exactly one assistant/conversation. Abort
  // it when the user switches chats or this hook unmounts so a hidden turn
  // cannot keep polling for six minutes and later surface a stale timeout.
  useEffect(
    () => () => {
      const observation = activeRequestPolledObservationRef.current;
      if (!observation) return;
      suppressRequestPolledObservation(observation);
      activeRequestPolledObservationRef.current = null;
    },
    [assistantId, activeConversationId],
  );

  // -------------------------------------------------------------------------
  // Queue management (delegated to useMessageQueue)
  // -------------------------------------------------------------------------
  const {
    revertQueuedMessage,
    queuedMessages,
    handleCancelQueuedMessage,
    handleCancelAllQueued,
    handleSteerMessage,
    handleEditQueueTail,
  } = useMessageQueue({
    assistantId,
    activeConversationId,
    messages,
  });

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  /**
   * Persist dismissed surface IDs to both the in-memory ref and local
   * storage. Extracted so `setMessages` updaters stay pure.
   */
  const persistDismissedSurfaces = useCallback((dismissedIds: Set<string>) => {
    useChatSessionStore.getState().addDismissedSurfaceIds(dismissedIds);
    const streamCtx = useStreamStore.getState().streamContext;
    if (streamCtx) {
      saveDismissedSurfaceIds(
        streamCtx.assistantId,
        streamCtx.conversationId,
        useChatSessionStore.getState().dismissedSurfaceIds,
      );
    }
  }, []);

  const repairMissingProviderProfile =
    useCallback(async (): Promise<ChatError | null> => {
      if (!assistantId) return null;
      try {
        const repair =
          await ensureRunnableProfileFromStoredConnection(assistantId);
        if (!repair.repaired) return null;

        void queryClient.invalidateQueries({
          queryKey: configGetQueryKey({ path: { assistant_id: assistantId } }),
        });

        return {
          message: `${repair.providerLabel ?? "Your AI provider"} is selected for this assistant now. Send your message again.`,
          code: "PROVIDER_PROFILE_REPAIRED",
        };
      } catch (err) {
        captureError(err, { context: "repair_missing_provider_profile" });
        return null;
      }
    }, [assistantId, queryClient]);

  const surfaceConversationAfterUserSend = useCallback(
    async (conversationId: string) => {
      if (!assistantId) return;
      if (surfacingConversationIdsRef.current.has(conversationId)) return;

      let conversation = findConversation(
        queryClient,
        assistantId,
        conversationId,
      );
      if (!conversation) {
        try {
          conversation = await fetchConversationDetail(
            queryClient,
            assistantId,
            conversationId,
          );
        } catch (err) {
          if (err instanceof ConversationNotFoundError) return;
          throw err;
        }
      }

      if (!shouldSurfaceConversationOnUserSend(conversation)) return;

      surfacingConversationIdsRef.current.add(conversationId);
      try {
        const surfacedAt = await surfaceConversation(
          assistantId,
          conversationId,
        );
        surfaceConversationInCaches(
          queryClient,
          assistantId,
          conversation,
          surfacedAt,
        );
      } finally {
        surfacingConversationIdsRef.current.delete(conversationId);
      }
    },
    [assistantId, queryClient],
  );

  // -------------------------------------------------------------------------
  // sendMessageViaStream — low-level POST + polling fallback
  // -------------------------------------------------------------------------
  const sendMessageViaStream = useCallback(
    async (
      content: string,
      epoch: number,
      turnId: string,
      attachmentIds: string[] = [],
      isDraft = false,
      clientMessageId?: string,
    ): Promise<SendStreamResult> => {
      if (!activeConversationId || !assistantId) {
        return {
          status: "failed",
          error: { message: "No active conversation. Please try again." },
        };
      }
      const requestAssistantId = assistantId;
      const requestConversationId = activeConversationId;
      const isCurrentSendScope = (resolvedConversationId?: string | null) =>
        isAsyncChatScopeCurrent({
          currentAssistantId:
            useResolvedAssistantsStore.getState().activeAssistantId,
          currentConversationId:
            useConversationStore.getState().activeConversationId,
          requestAssistantId,
          requestConversationId,
          resolvedConversationId,
        });

      const onboardingContext =
        pendingOnboardingContextRef.current ?? consumePendingPreChatContext();
      if (onboardingContext && !pendingOnboardingContextRef.current) {
        pendingOnboardingContextRef.current = onboardingContext;
      }
      // Server-minted flow: when the conversation is a fresh client-side
      // draft AND the assistant supports server-side minting, send the
      // POST without any conversation id wire field. The assistant mints
      // a row and returns its id as `postResult.conversationId`; the
      // existing draft-key-resolution code path below swaps the
      // optimistic state and navigates the URL. Falling back to the
      // assistant-known `requestConversationId` for non-drafts or
      // pre-0.8.6 assistants preserves the legacy `conversationKey`
      // create-or-lookup behavior through `pickConversationIdWireField()`.
      const resolvedAssistant = useResolvedAssistantsStore
        .getState()
        .assistants.find((item) => item.id === requestAssistantId);
      const usePooledPolling = usesPooledRequestPolling(resolvedAssistant);
      const useServerMint =
        !usePooledPolling &&
        isDraft &&
        (isDraftConversationId(requestConversationId) ||
          supportsServerMintedConversation());
      // While this POST is in flight, `sendMessage` rejects new sends
      // for this draft — see `pendingDraftMintRef` declaration above.
      if (useServerMint || (usePooledPolling && isDraft)) {
        pendingDraftMintRef.current = requestConversationId;
      }
      // A model profile the user picked in the composer before this
      // conversation's row was available — a brand-new draft, or an existing
      // conversation opened by URL while still loading (see
      // `ComposerSettingsMenu`). Forward it so this turn, and the conversation's
      // per-conversation override, use the chosen profile instead of the global
      // default — covering the window before the menu's load-time promotion PUT
      // lands. Keyed by id, so only this conversation's own stash is read.
      const inferenceProfileForSend = useConversationStore
        .getState()
        .pendingDraftProfiles.get(requestConversationId);
      const correlationClientMessageId = clientMessageId ?? crypto.randomUUID();

      /**
       * Restore a pending prompt through the same interaction store and
       * transcript attachment path used after an SSE reconnect. This only
       * displays the normal approval UI; execution still requires the user to
       * submit a decision through the authenticated confirmation endpoint.
       */
      const restorePendingInteractionState = async (
        resolvedConversationId: string,
      ): Promise<boolean> =>
        restoreRequestPolledInteractions({
          assistantId: requestAssistantId,
          conversationId: resolvedConversationId,
          isCurrent: () => isCurrentSendScope(resolvedConversationId),
        });

      const applyRequestPolledSnapshot = async (
        snapshot: Awaited<ReturnType<typeof fetchConversationMessages>>,
      ) => {
        const resolvedConversationId = snapshot?.conversationId;
        const activeObservation =
          activeRequestPolledObservationRef.current;
        if (
          resolvedConversationId &&
          activeObservation?.turnId === turnId
        ) {
          activeObservation.resolvedConversationId = resolvedConversationId;
        }
        if (
          !resolvedConversationId ||
          !isCurrentSendScope(resolvedConversationId)
        ) {
          return;
        }

        // Approval actions read this context. Set it as soon as polling
        // resolves a first-message conversation instead of waiting for the
        // long-running POST to finish.
        useStreamStore.getState().setStreamContext({
          assistantId: requestAssistantId,
          conversationId: resolvedConversationId,
        });

        const serverMessages = snapshot.messages ?? [];
        if (serverMessages.length > 0) {
          const serverSeq = snapshot.seq ?? null;
          const localSeq = getLocalSeq(resolvedConversationId);
          recordLocalSeq(resolvedConversationId, serverSeq);
          setMessages((prev) => {
            if (!isCurrentSendScope(resolvedConversationId)) return prev;
            return reconcileSnapshot(prev, serverMessages, {
              serverSeq,
              localSeq,
            });
          });
        }

        // The agent can be paused inside PermissionPrompter while the message
        // POST (and pooled-worker lease) is intentionally still open. Read the
        // interaction registry on every bounded snapshot so the normal Allow /
        // Deny card is available to unblock that same turn.
        await restorePendingInteractionState(resolvedConversationId);
      };

      const postMessage = () =>
        postChatMessage(
          requestAssistantId,
          useServerMint ? null : requestConversationId,
          content,
          attachmentIds,
          onboardingContext ?? undefined,
          correlationClientMessageId,
          inferenceProfileForSend,
          usePooledPolling && isDraft
            ? { conversationWireField: "conversationKey" }
            : undefined,
        );

      const requestPolledTurn = usePooledPolling
        ? beginRequestPolledTurn({
            post: postMessage,
            observe: (signal) =>
              pollForResponse(requestAssistantId, "", requestConversationId, {
                ...(isDraft ? { conversationKey: requestConversationId } : {}),
                clientMessageId: correlationClientMessageId,
                signal,
                timeoutMs: POOLED_REQUEST_POLL_TIMEOUT_MS,
                onSnapshot: applyRequestPolledSnapshot,
              }),
          })
        : null;
      const requestPolledObservation = requestPolledTurn
        ? createActiveRequestPolledObservation({
            assistantId: requestAssistantId,
            requestConversationId,
            turnId,
            stopObservation: requestPolledTurn.stopObservation,
          })
        : null;
      if (requestPolledObservation) {
        const previous = activeRequestPolledObservationRef.current;
        if (previous && previous !== requestPolledObservation) {
          suppressRequestPolledObservation(previous);
        }
        activeRequestPolledObservationRef.current = requestPolledObservation;
      }
      const stopRequestPolledObservation = () => {
        if (!requestPolledObservation) return;
        suppressRequestPolledObservation(requestPolledObservation);
        if (
          activeRequestPolledObservationRef.current ===
          requestPolledObservation
        ) {
          activeRequestPolledObservationRef.current = null;
        }
      };

      let postResult: Awaited<ReturnType<typeof postChatMessage>>;
      try {
        postResult = await (requestPolledTurn?.postResult ?? postMessage());
      } catch (error) {
        stopRequestPolledObservation();
        if (pendingDraftMintRef.current === requestConversationId) {
          pendingDraftMintRef.current = null;
        }
        throw error;
      }
      if (
        (useServerMint || (usePooledPolling && isDraft)) &&
        pendingDraftMintRef.current === requestConversationId
      ) {
        // Clear only if we still own the gate. A re-mount or scope flip
        // during the await could have already replaced it with a newer
        // draft's mint.
        pendingDraftMintRef.current = null;
      }
      if (!postResult.ok) {
        stopRequestPolledObservation();
        if (!isCurrentSendScope()) {
          recordDiagnostic("send_error_ignored_inactive_conversation", {
            assistantId: requestAssistantId,
            conversationId: requestConversationId,
            activeAssistantId:
              useResolvedAssistantsStore.getState().activeAssistantId,
            activeConversationId:
              useConversationStore.getState().activeConversationId,
          });
          return { status: "ignored" };
        }
        const detail = resolvePostError(
          postResult.error.code,
          postResult.error.detail,
          "Something went wrong. Please try again.",
        );
        endTurn({ conversationId: requestConversationId, reason: "error" });
        return {
          status: "failed",
          error: {
            message: detail,
            ...(postResult.error.code ? { code: postResult.error.code } : {}),
            status: postResult.status,
          },
        };
      }
      // Success — drain the ref so subsequent messages omit the field.
      pendingOnboardingContextRef.current = null;
      // The draft's stashed profile (if any) has now been persisted on the
      // minted conversation; drop this draft's entry so it can't re-apply to a
      // later send. Cleared only on success — a failed draft send keeps the
      // stash so a retry still carries the chosen profile.
      if (inferenceProfileForSend) {
        useConversationStore
          .getState()
          .clearPendingDraftProfile(requestConversationId);
      }
      if (onboardingDraftConversationIdRef.current === activeConversationId) {
        onboardingDraftConversationIdRef.current = null;
      }

      if (isCurrentSendScope()) {
        useTurnStore.getState().acceptSend(turnId);
      }

      // `postChatMessage`'s success contract guarantees a non-empty
      // `conversationId` — the server-mint path explicitly returns a
      // failure when the assistant accepts the message without echoing
      // a conversation id back, so by the time we get here it must be
      // a real id. The typecheck enforces this; the explicit
      // `effectiveConversationId` alias preserves the existing names
      // used downstream.
      const effectiveConversationId = postResult.conversationId;

      if (!isCurrentSendScope(effectiveConversationId)) {
        stopRequestPolledObservation();
        recordDiagnostic("send_result_ignored_inactive_conversation", {
          assistantId: postResult.assistantId,
          conversationId: requestConversationId,
          resolvedConversationId: effectiveConversationId,
          activeAssistantId:
            useResolvedAssistantsStore.getState().activeAssistantId,
          activeConversationId:
            useConversationStore.getState().activeConversationId,
        });
        return {
          status: "ok",
          resolvedConversationId: postResult.conversationId,
        };
      }

      void surfaceConversationAfterUserSend(effectiveConversationId).catch(
        (err) => {
          captureError(err, { context: "surface_conversation_after_send" });
        },
      );

      const streamState = useStreamStore.getState();
      const existingStreamContext = streamState.streamContext;
      const hasMatchingActiveStream =
        !!streamState.stream &&
        existingStreamContext?.assistantId === postResult.assistantId &&
        existingStreamContext.conversationId === effectiveConversationId;

      streamState.setStreamContext({
        assistantId: postResult.assistantId,
        conversationId: effectiveConversationId,
      });

      if (postResult.queued) {
        stopRequestPolledObservation();
        return {
          status: "ok",
          resolvedConversationId: postResult.conversationId,
        };
      }
      if (hasMatchingActiveStream) {
        stopRequestPolledObservation();
        return {
          status: "ok",
          userMessageId: postResult.messageId,
          resolvedConversationId: postResult.conversationId,
        };
      }

      const responsePoll =
        requestPolledTurn?.observation ??
        pollForResponse(
          postResult.assistantId,
          postResult.messageId,
          effectiveConversationId,
          {
            onSnapshot: (snapshot) => {
              if (!isCurrentSendScope(effectiveConversationId)) return;
              const serverMessages = snapshot.messages ?? [];
              if (serverMessages.length === 0) return;
              const serverSeq = snapshot.seq ?? null;
              const localSeq = getLocalSeq(effectiveConversationId);
              recordLocalSeq(effectiveConversationId, serverSeq);
              setMessages((prev) => {
                if (!isCurrentSendScope(effectiveConversationId)) return prev;
                return reconcileSnapshot(prev, serverMessages, {
                  serverSeq,
                  localSeq,
                });
              });
            },
          },
        );

      responsePoll
        .then(async (reply) => {
          if (requestPolledObservation?.resultSuppressed) return;
          if (!isCurrentSendScope(effectiveConversationId)) {
            recordDiagnostic("poll_response_ignored_inactive_conversation", {
              assistantId: postResult.assistantId,
              conversationId: requestConversationId,
              resolvedConversationId: effectiveConversationId,
              activeAssistantId:
                useResolvedAssistantsStore.getState().activeAssistantId,
              activeConversationId:
                useConversationStore.getState().activeConversationId,
            });
            return;
          }
          const restoredInteraction = await restorePendingInteractionState(
            effectiveConversationId,
          );
          if (restoredInteraction && !reply) return;

          if (!reply) {
            setError({ message: "Assistant did not respond in time." });
            return;
          }
          let serverMessages: ConversationMessage[] = [];
          let serverSeq: number | null = null;
          try {
            const snapshot = await fetchConversationMessages(
              postResult.assistantId,
              effectiveConversationId,
            );
            serverMessages = snapshot?.messages ?? [];
            serverSeq = snapshot?.seq ?? null;
          } catch {
            // Reconciliation is best-effort
          }
          if (!isCurrentSendScope(effectiveConversationId)) return;
          // Capture the local seq `L` before advancing it so the merge
          // can tell whether this snapshot moved the frontier (`S > L`).
          const localSeq = getLocalSeq(effectiveConversationId);
          recordLocalSeq(effectiveConversationId, serverSeq);
          setMessages((prev) => {
            if (!isCurrentSendScope(effectiveConversationId)) return prev;
            if (serverMessages.length > 0) {
              return reconcileSnapshot(prev, serverMessages, {
                serverSeq,
                localSeq,
              });
            }
            const mapped = mapRuntimeToDisplayMessage(reply);
            const existingIdx = prev.findIndex((m) => m.id === reply.id);
            if (existingIdx >= 0) {
              const existing = prev[existingIdx];
              const updated = [...prev];
              updated[existingIdx] = {
                ...mapped,
                timestamp:
                  existing?.timestamp ?? mapped.timestamp ?? Date.now(),
              };
              return updated;
            }
            return [
              ...prev,
              { ...mapped, timestamp: mapped.timestamp ?? Date.now() },
            ];
          });
          startReconciliationLoop(epoch);
        })
        .catch((err) => {
          if (requestPolledObservation?.resultSuppressed) return;
          if (!isCurrentSendScope(effectiveConversationId)) return;
          captureError(err, { context: "send_message_stream" });
          setError({ message: "Connection lost. Please try again." });
        })
        .finally(() => {
          if (
            activeRequestPolledObservationRef.current ===
            requestPolledObservation
          ) {
            activeRequestPolledObservationRef.current = null;
          }
          if (requestPolledObservation?.resultSuppressed) return;
          if (!isCurrentSendScope(effectiveConversationId)) return;
          // Defense-in-depth: settle the turn if SSE didn't already.
          // `onPollReconciled` no-ops when the turn is already idle, so
          // this is safe to call alongside the SSE terminal handlers.
          endTurn({
            conversationId: effectiveConversationId,
            reason: "rescued",
            rescuedTurnId: turnId,
          });
        });

      return {
        status: "ok",
        userMessageId: postResult.messageId,
        resolvedConversationId: postResult.conversationId,
      };
    },
    [
      activeConversationId,
      assistantId,
      startReconciliationLoop,
      surfaceConversationAfterUserSend,
    ],
  );

  // -------------------------------------------------------------------------
  // sendMessage — high-level send with UI state, queuing, draft resolution
  // -------------------------------------------------------------------------
  const sendMessage = useCallback(
    async (content: string, attachments: DisplayAttachment[] = []) => {
      if (!activeConversationId || !assistantId) {
        setError({ message: "No active conversation. Please try again." });
        return;
      }
      // Block any second send while the active draft's first POST is in
      // flight. The queue path cannot safely target the conversation until
      // that request returns its authoritative internal id. See
      // `pendingDraftMintRef` declaration.
      if (pendingDraftMintRef.current === activeConversationId) {
        setError({
          message:
            "Your first message is still being processed. Please try again in a moment.",
        });
        return;
      }
      if (diskPressureChatBlockReason) {
        setError({
          message: getDiskPressureChatBlockMessage(diskPressureChatBlockReason),
        });
        return;
      }
      setError(null);
      useInteractionStore.getState().resetSecretAndConfirmation();
      useChatSessionStore.getState().clearConfirmationToolCallMap();
      // Clear pending confirmations and dismiss interactive surfaces in a
      // single functional updater so the two transforms compose correctly
      // within React 18's batched state updates. Side effects (ref mutation,
      // localStorage persist) are kept outside the updater to stay pure.
      const messagesForScan = useChatSessionStore.getState().messages;
      setMessages((prev) => {
        const cleared = clearPendingConfirmationsFromMessages(prev);
        const { updatedMessages, dismissedIds } = dismissInteractiveSurfaces(
          cleared,
          messagesForScan,
        );
        return dismissedIds.size > 0 ? updatedMessages : cleared;
      });

      // Persist dismissed surfaces outside the updater (side effect).
      const { dismissedIds } = dismissInteractiveSurfaces(
        useChatSessionStore.getState().messages,
        messagesForScan,
      );
      if (dismissedIds.size > 0) {
        persistDismissedSurfaces(dismissedIds);
        useTurnStore.getState().dismissSurface();
      }

      const willQueue = isSending(useTurnStore.getState().phase);
      const clientMessageId = crypto.randomUUID();
      const userMessage: DisplayMessage = {
        id: clientMessageId,
        clientMessageId,
        isOptimistic: true,
        role: "user",
        textSegments: [content],
        contentOrder: [{ type: "text", id: "0" }],
        contentBlocks:
          content.trim().length > 0 ? [{ type: "text", text: content }] : [],
        timestamp: Date.now(),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(willQueue
          ? { queueStatus: "queued" as const, queuePosition: 0 }
          : {}),
      };
      setMessages((prev) => [...prev, userMessage]);

      // Queue path: POST to assistant (it queues internally) but don't
      // disrupt the active turn.
      if (willQueue) {
        useChatSessionStore
          .getState()
          .pushPendingQueuedMessageId(userMessage.id);
        const attachmentIds = attachments.map((att) => att.id);
        try {
          const postResult = await postChatMessage(
            assistantId,
            activeConversationId,
            content,
            attachmentIds,
            undefined,
            clientMessageId,
          );
          if (!postResult.ok) {
            revertQueuedMessage(userMessage.id);
            if (
              shouldAttemptProviderProfileRepair({
                code: postResult.error.code,
                detail: postResult.error.detail,
                status: postResult.status,
              })
            ) {
              const repaired = await repairMissingProviderProfile();
              if (repaired) {
                useComposerStore.getState().setInput(content);
                setError(repaired);
                return;
              }
            }
            const detail = resolvePostError(
              postResult.error.code,
              postResult.error.detail,
              "Failed to queue message. Please try again.",
            );
            setError({
              message: detail,
              code: postResult.error.code ?? undefined,
              status: postResult.status,
            });
            return;
          }
          void surfaceConversationAfterUserSend(
            postResult.conversationId,
          ).catch((err) => {
            captureError(err, {
              context: "surface_queued_conversation_after_send",
            });
          });
          if (!postResult.queued) {
            // The daemon processed the message directly (turn finished
            // between the client-side isSending check and the POST
            // arriving). Clear the optimistic queue status and let the
            // existing SSE stream deliver the response.
            const queueIds =
              useChatSessionStore.getState().pendingQueuedMessageIds;
            const idx = queueIds.indexOf(userMessage.id);
            if (idx !== -1) queueIds.splice(idx, 1);
            setMessages((prev) => clearQueueStatus(prev, userMessage.id));
            const fallbackTurnId = newTurnId();
            useTurnStore.getState().requestSend(fallbackTurnId);
            useTurnStore.getState().acceptSend(fallbackTurnId);
            {
              const currentConv = findConversation(
                queryClient,
                assistantId,
                activeConversationId,
              );
              useConversationStore
                .getState()
                .addProcessingConversationId(
                  activeConversationId,
                  currentConv?.latestAssistantMessageAt,
                );
            }
            return;
          }
          if (postResult.requestId) {
            useChatSessionStore
              .getState()
              .setRequestIdMapping(postResult.requestId, userMessage.id);
          }
        } catch (err) {
          captureError(err, { context: "send_message_queue" });
          revertQueuedMessage(userMessage.id);
          setError({ message: "Failed to queue message. Please try again." });
        }
        return;
      }

      const turnId = newTurnId();
      useTurnStore.getState().requestSend(turnId);

      const currentConv = findConversation(
        queryClient,
        assistantId,
        activeConversationId,
      );
      useConversationStore
        .getState()
        .addProcessingConversationId(
          activeConversationId,
          currentConv?.latestAssistantMessageAt,
        );

      // Optimistically add a stub conversation to the sidebar for draft
      // conversations that don't exist on the server yet.
      if (!currentConv) {
        prependConversation(queryClient, assistantId, {
          conversationId: activeConversationId,
          lastMessageAt: Date.now(),
          draft: true,
        } as Conversation);
      }

      cancelReconciliation();

      const isDraft = !currentConv;
      let resolvedId: string | undefined;

      try {
        const result = await sendMessageViaStream(
          content,
          useStreamStore.getState().streamEpoch,
          turnId,
          attachments.map((att) => att.id),
          isDraft,
          clientMessageId,
        );

        if (result.status === "failed") {
          // Roll back every piece of optimistic state we just set up: the
          // bubble in the transcript, the processing flag on the conversation,
          // the prepended draft conversation in the sidebar, and the cleared
          // composer input. Then surface the error.
          setMessages((prev) => prev.filter((m) => m.id !== userMessage.id));
          useConversationStore
            .getState()
            .removeProcessingConversationId(activeConversationId);
          const repaired = shouldAttemptProviderProfileRepair(result.error)
            ? await repairMissingProviderProfile()
            : null;
          if (isDraft) {
            removeConversation(queryClient, assistantId, activeConversationId);
            if (repaired) {
              setError({
                ...repaired,
                displayAs: "modal",
                restoreContent: content,
              });
              return;
            }
            setError({
              message: result.error.message,
              ...(result.error.code ? { code: result.error.code } : {}),
              ...(result.error.status ? { status: result.error.status } : {}),
              displayAs: "modal",
              restoreContent: content,
            });
          } else {
            useComposerStore.getState().setInput(content);
            if (repaired) {
              setError(repaired);
              return;
            }
            setError(result.error);
          }
          return;
        }

        if (result.status === "ignored") {
          // Scope changed mid-flight; the new scope owns UI state from here.
          return;
        }

        resolvedId = result.resolvedConversationId;

        // POST resolve — swap the optimistic user row's client id for the
        // server's. Gate on `isOptimistic` so a reconcile that already
        // swapped this row doesn't get clobbered. Queued sends skip this
        // and keep their optimistic id until the daemon echoes their
        // `clientMessageId` back on the persisted row.
        if (result.userMessageId) {
          const serverUserMessageId = result.userMessageId;
          setMessages((prev) =>
            prev.map((m) =>
              m.isOptimistic && m.id === clientMessageId
                ? { ...m, id: serverUserMessageId, isOptimistic: false }
                : m,
            ),
          );
        }

        // Resolve draft key -> server-assigned conversation ID.
        if (resolvedId && resolvedId !== activeConversationId) {
          const newConversationId = resolvedId;
          useConversationStore
            .getState()
            .transferProcessingConversationId(
              activeConversationId,
              newConversationId,
            );
          resolveDraftKey(
            queryClient,
            assistantId,
            activeConversationId,
            newConversationId,
          );
          resolveEditChatDraftConversationId(
            activeConversationId,
            newConversationId,
          );

          // Only update active view state if the user is still on this conversation.
          if (
            useConversationStore.getState().activeConversationId ===
            activeConversationId
          ) {
            useChatSessionStore.getState().markDraftResolution();
            useChatSessionStore.setState({
              previousConversationId: newConversationId,
            });
            useConversationStore
              .getState()
              .setActiveConversationId(newConversationId);
            void navigate(routes.conversation(newConversationId), {
              replace: true,
            });
          }
        }

        void refreshConversations();
      } catch (err) {
        captureError(err, { context: "send_chat_message" });
        setError({ message: "Something went wrong. Please try again." });
        // Multi-key processing-key cleanup: when a send is retargeted
        // (e.g. draft → new conversation), both the original active key
        // and the resolved key may have processing markers. `endTurn`
        // covers the single-conversation pairing; this catch-all clears
        // every key the send touched and fires `onStreamError` once.
        useTurnStore.getState().onStreamError();
        const keysToClean = [activeConversationId, resolvedId].filter(
          Boolean,
        ) as string[];
        if (keysToClean.length > 0) {
          useConversationStore
            .getState()
            .removeMultipleProcessingConversationIds(keysToClean);
        }
        if (isDraft) {
          removeConversation(queryClient, assistantId, activeConversationId);
        }
      }
    },
    [
      activeConversationId,
      assistantId,
      diskPressureChatBlockReason,
      sendMessageViaStream,
      refreshConversations,
      revertQueuedMessage,
      persistDismissedSurfaces,
      repairMissingProviderProfile,
      queryClient,
      surfaceConversationAfterUserSend,
    ],
  );

  // -------------------------------------------------------------------------
  // handleStopGenerating — cancel the active generation
  // -------------------------------------------------------------------------
  const handleStopGenerating = useCallback(async () => {
    if (!assistantId || !activeConversationId) return;
    const pooledCancellationConversationId =
      stopMatchingRequestPolledObservation(
        activeRequestPolledObservationRef.current,
        assistantId,
        activeConversationId,
      );
    if (pooledCancellationConversationId) {
      activeRequestPolledObservationRef.current = null;
    }
    useStreamStore.getState().bumpEpoch();
    patchConversation(queryClient, assistantId, activeConversationId, {
      isProcessing: false,
    });
    endTurn({ conversationId: activeConversationId, reason: "cancelled" });
    setMessages(clearPendingConfirmationsFromMessages);
    useInteractionStore.getState().resetAll();
    useSubagentStore.getState().reset();
    useChatSessionStore.getState().clearConfirmationToolCallMap();
    try {
      await conversationsByIdCancelPost({
        path: {
          assistant_id: assistantId,
          id: pooledCancellationConversationId ?? activeConversationId,
        },
        throwOnError: true,
      });
    } catch {
      // Best-effort — the daemon may have already finished
    }
  }, [assistantId, activeConversationId, queryClient]);

  return {
    sendMessage,
    handleStopGenerating,
    queuedMessages,
    handleCancelQueuedMessage,
    handleCancelAllQueued,
    handleSteerMessage,
    handleEditQueueTail,
  };
}
