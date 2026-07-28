import type { Assistant } from "@/assistant/api";
import { setSelectedAssistant } from "@/assistant/selection";
import { completeOnboarding } from "@/domains/account/profile";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useAuthStore } from "@/stores/auth-store";

export async function completeAccountOnboarding(): Promise<Assistant> {
  const result = await completeOnboarding();
  const assistant = result.assistant as Assistant;

  useAuthStore.setState((state) => ({
    user: state.user
      ? { ...state.user, onboardingCompleted: true }
      : state.user,
  }));
  useResolvedAssistantsStore.getState().upsertFromApi(assistant);
  useResolvedAssistantsStore
    .getState()
    .setActiveAssistantId(assistant.id);
  await setSelectedAssistant(assistant.id);
  return assistant;
}
