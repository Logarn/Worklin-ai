/**
 * Empty-state data for the chat — greeting text, conversation-starter
 * chips, and the avatar render function.
 *
 * Provides the Worklin farm-operator empty state and handles the app-editing
 * override where the greeting and starters are derived from the opened app
 * instead of the farm defaults.
 */

import { type ReactNode, useMemo } from "react";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import type { ChatEmptyStateProps } from "@/domains/chat/components/chat-empty-state";
import { ConversationStarterGrid } from "@/domains/chat/components/conversation-starter-grid";
import {
  buildEditAppGreeting,
  buildEditAppStarters,
} from "@/domains/chat/utils/edit-app-empty-state";
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

const WORKLIN_FARM_STARTERS: ConversationStarter[] = [
  {
    id: "worklin-farm-status",
    label: "How are we doing?",
    prompt:
      "Give me a brief status of the farm. Separate confirmed facts from estimates, tell me what needs attention, and do not contact anyone or take external action unless I approve it.",
    category: "farm-operations",
    batch: 0,
  },
  {
    id: "worklin-record-farm-update",
    label: "Record a farm update",
    prompt:
      "I want to record a flock, feed, worker, sale, expense, or maintenance update. Ask only for the details needed to keep the farm record accurate.",
    category: "farm-operations",
    batch: 0,
  },
  {
    id: "worklin-plan-feed-order",
    label: "Plan the next feed order",
    prompt:
      "Help me work out when we will run out of feed and what to order. Use confirmed records where available, list missing information, and do not contact suppliers without my approval.",
    category: "farm-operations",
    batch: 0,
  },
  {
    id: "worklin-farm-attention",
    label: "What needs my attention?",
    prompt:
      "Review the farm's open work, risks, and missing confirmations. Show only the items that need a decision or follow-up, and be clear about what is not yet verified.",
    category: "farm-operations",
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
    avatarSlot: (
      <ChatAvatar
        components={avatarComponents}
        traits={avatarTraits}
        customImageUrl={avatarImageUrl}
        characterProfile={characterProfile}
        size={40}
        interactive
        isProcessing={activeConversationIsProcessing}
      />
    ),
    greeting: editingApp
      ? buildEditAppGreeting(editingApp)
      : DEFAULT_EMPTY_STATE_GREETING,
    isGenerating: false,
  };

  const emptyStateStarters = editingApp
    ? buildEditAppStarters(editingApp)
    : WORKLIN_FARM_STARTERS;

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
    () => () => (
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
    ),
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
