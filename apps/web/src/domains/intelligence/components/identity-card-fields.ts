import type { IdentityGetResponse } from "@/generated/daemon/types.gen";
import type { AssistantCharacterProfile } from "@/types/assistant-character-profile";

interface IdentityCardFields {
  name: string;
  personality: string;
  role: string;
}

export function resolveIdentityCardFields(
  identity: IdentityGetResponse | null,
  characterProfile: AssistantCharacterProfile | null,
): IdentityCardFields {
  return {
    name: identity?.name || characterProfile?.assistantName || "Assistant",
    personality:
      identity?.personality || characterProfile?.personalityText || "",
    role: identity?.role || characterProfile?.role || "Not set",
  };
}
