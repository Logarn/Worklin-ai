import { daemonApiBaseUrl, platformApiBaseUrl } from "@/lib/api-origins";
import type { Assistant } from "@/generated/api/types.gen";

type AssistantHostingShape = Pick<
  Assistant,
  "is_local"
> &
  Partial<Pick<Assistant, "ingress_url" | "platform_actor_token">>;

function normalizeOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isPlatformIngressOrigin(url: string | null | undefined): boolean {
  const ingressOrigin = normalizeOrigin(url);
  if (!ingressOrigin) return false;
  const platformOrigin = normalizeOrigin(platformApiBaseUrl);
  const daemonOrigin = normalizeOrigin(daemonApiBaseUrl);
  return ingressOrigin === platformOrigin || ingressOrigin === daemonOrigin;
}

export function isPlatformManagedAssistant(
  assistant: AssistantHostingShape,
): boolean {
  if (assistant.is_local !== true) return true;
  if (assistant.platform_actor_token) return true;
  return isPlatformIngressOrigin(assistant.ingress_url);
}

export function isHostedAssistant(
  assistant: AssistantHostingShape,
): boolean {
  return isPlatformManagedAssistant(assistant);
}

export function filterHostedAssistants<T extends AssistantHostingShape>(
  assistants: readonly T[],
): T[] {
  return assistants.filter(isHostedAssistant);
}

export function firstHostedAssistant<T extends AssistantHostingShape>(
  assistants: readonly T[],
): T | null {
  return filterHostedAssistants(assistants)[0] ?? null;
}
