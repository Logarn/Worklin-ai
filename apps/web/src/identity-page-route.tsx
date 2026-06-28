import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { useConversationStore } from "@/stores/conversation-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { IdentityPage } from "@/domains/intelligence/identity-page";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

export function IdentityPageRoute() {
  const navigate = useNavigate();
  const assistantId = useActiveAssistantId();
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  const selfHostedChatEnabled = useClientFeatureFlagStore.use.selfHostedAssistant();
  const canOpenThread =
    assistantState.kind === "active" ||
    (assistantState.kind === "self_hosted" && selfHostedChatEnabled);

  return (
    <IdentityPage
      key={assistantId}
      onOpenThread={
        canOpenThread
          ? (message) => {
              useViewerStore.getState().setMainView("chat");
              const draftConversationId = createDraftConversationId();
              useConversationStore.getState().setActiveConversationId(draftConversationId);
              void navigate(
                `${routes.conversation(draftConversationId)}?prompt=${encodeURIComponent(message)}`,
              );
            }
          : undefined
      }
    />
  );
}
