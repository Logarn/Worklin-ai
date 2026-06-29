import type { Assistant } from "@/generated/api/types.gen";

export function isHostedAssistant(
  assistant: Pick<Assistant, "is_local">,
): boolean {
  return assistant.is_local !== true;
}

export function filterHostedAssistants<T extends Pick<Assistant, "is_local">>(
  assistants: readonly T[],
): T[] {
  return assistants.filter(isHostedAssistant);
}

export function firstHostedAssistant<T extends Pick<Assistant, "is_local">>(
  assistants: readonly T[],
): T | null {
  return filterHostedAssistants(assistants)[0] ?? null;
}
