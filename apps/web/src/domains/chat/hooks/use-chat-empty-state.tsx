/**
 * Empty-state data for the chat — greeting text, conversation-starter
 * chips, and the avatar render function.
 *
 * Provides the Worklin retention empty state and handles the app-editing
 * override where the greeting and starters are derived from the opened app
 * instead of the retention defaults.
 */

import { type ReactNode, useMemo } from "react";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import type { ChatEmptyStateProps } from "@/domains/chat/components/chat-empty-state";
import { ConversationStarterGrid } from "@/domains/chat/components/conversation-starter-grid";
import { buildEditAppGreeting, buildEditAppStarters } from "@/domains/chat/utils/edit-app-empty-state";
import {
  DEFAULT_EMPTY_STATE_GREETING,
  pickRandomPlaceholder,
} from "@/domains/chat/utils/empty-state-constants";
import type { ConversationStarter } from "@/domains/chat/utils/conversation-starters";
import type { useAssistantAvatar } from "@/hooks/use-assistant-avatar";

// ---------------------------------------------------------------------------
// Params & return type
// ---------------------------------------------------------------------------

export interface UseChatEmptyStateParams {
  assistantId: string | null;
  /** Active empty conversation id — a change regenerates the greeting. */
  conversationId: string | null | undefined;
  isEmptyConversation: boolean;
  avatar: ReturnType<typeof useAssistantAvatar>;
  /** Current main view from viewer-store. */
  mainView: string;
  /** Opened app state from viewer-store (non-null when editing an app). */
  openedAppState: { name: string; dirName?: string } | null;
  isAssistantStreaming: boolean;
  activeConversationIsProcessing: boolean;
  onSelectStarter: (starter: ConversationStarter) => void;
}

export interface ChatEmptyStateResult {
  emptyStateProps: ChatEmptyStateProps;
  startersSlot: ReactNode | undefined;
  renderAvatar: (() => ReactNode) | undefined;
  emptyStatePlaceholder: string;
}

const WORKLIN_RETENTION_STARTERS: ConversationStarter[] = [
  {
    id: "worklin-start-guided-onboarding",
    label: "Start guided onboarding",
    prompt:
      "I want to onboard a new brand. Please guide me one question at a time.",
    category: "retention",
    batch: 0,
  },
  {
    id: "worklin-run-retention-audit",
    label: "Run account audit",
    prompt:
      "Can you run a read-only retention audit for my account and tell me the biggest areas to improve?",
    category: "retention",
    batch: 0,
  },
  {
    id: "worklin-connect-klaviyo",
    label: "Connect Klaviyo",
    prompt:
      "I want to connect my Klaviyo account so Worklin can audit campaigns, flows, forms, audiences, and metrics.",
    category: "retention",
    batch: 0,
  },
  {
    id: "worklin-check-lifecycle-gaps",
    label: "Check lifecycle gaps",
    prompt:
      "Can you check my lifecycle coverage and tell me which flows, segments, or signup paths are missing?",
    category: "retention",
    batch: 0,
  },
];

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChatEmptyState({
  isEmptyConversation,
  avatar,
  mainView,
  openedAppState,
  isAssistantStreaming,
  activeConversationIsProcessing,
  onSelectStarter,
}: UseChatEmptyStateParams): ChatEmptyStateResult {
  const {
    components: avatarComponents,
    traits: avatarTraits,
    customImageUrl: avatarImageUrl,
    characterProfile,
  } = avatar;

  const emptyStatePlaceholder = useMemo(() => pickRandomPlaceholder(), []);

  const editingApp =
    mainView === "app-editing" && openedAppState
      ? { name: openedAppState.name, dirName: openedAppState.dirName }
      : null;

  const emptyStateProps: ChatEmptyStateProps = {
    avatarSlot:
      characterProfile || avatarComponents || avatarImageUrl ? (
        <ChatAvatar
          components={avatarComponents}
          traits={avatarTraits}
          customImageUrl={avatarImageUrl}
          characterProfile={characterProfile}
          size={40}
          interactive
          isProcessing={activeConversationIsProcessing}
        />
      ) : null,
    greeting: editingApp
      ? buildEditAppGreeting(editingApp)
      : DEFAULT_EMPTY_STATE_GREETING,
    isGenerating: false,
  };

  const emptyStateStarters = editingApp
    ? buildEditAppStarters(editingApp)
    : WORKLIN_RETENTION_STARTERS;

  const startersSlot =
    isEmptyConversation && emptyStateStarters.length > 0 ? (
      <div className="mt-4">
        <ConversationStarterGrid
          starters={emptyStateStarters}
          onSelect={onSelectStarter}
        />
      </div>
    ) : undefined;

  // Stable callback so the latest-turn avatar slot isn't rebuilt on every
  // transcript render. Paired with `memo(ChatAvatar)`, the avatar
  // re-renders only when its inputs actually change.
  const renderAvatar = useMemo(
    () =>
      characterProfile || avatarComponents || avatarImageUrl
        ? () => (
            <ChatAvatar
              components={avatarComponents}
              traits={avatarTraits}
              customImageUrl={avatarImageUrl}
              characterProfile={characterProfile}
              size={28}
              interactive
              isStreaming={isAssistantStreaming}
              isProcessing={activeConversationIsProcessing}
            />
          )
        : undefined,
    [
      avatarComponents,
      avatarImageUrl,
      avatarTraits,
      characterProfile,
      isAssistantStreaming,
      activeConversationIsProcessing,
    ],
  );

  return { emptyStateProps, startersSlot, renderAvatar, emptyStatePlaceholder };
}
