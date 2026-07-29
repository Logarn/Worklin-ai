import type { Assistant } from "@/assistant/api";
import { setSelectedAssistant } from "@/assistant/selection";
import { completeOnboarding } from "@/domains/account/profile";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useAuthStore } from "@/stores/auth-store";

export interface AccountOnboardingResult {
  assistant: Assistant;
  completed: boolean;
}

export async function completeAccountOnboarding(): Promise<AccountOnboardingResult> {
  const result = await completeOnboarding();
  const assistant = result.assistant as Assistant;
  const completed = result.user.onboarding_completed === true;

  useAuthStore.setState((state) => ({
    user: state.user
      ? { ...state.user, onboardingCompleted: completed }
      : state.user,
  }));
  useResolvedAssistantsStore.getState().upsertFromApi(assistant);
  useResolvedAssistantsStore.getState().setActiveAssistantId(assistant.id);
  await setSelectedAssistant(assistant.id);
  return { assistant, completed };
}
