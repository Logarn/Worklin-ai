import type { QueryClient } from "@tanstack/react-query";

import type { IdentityGetResponse } from "@/generated/daemon/types.gen";
import { assistantIdentityQueryKey } from "@/lib/sync/query-tags";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

export function applySavedIdentity({
  identity,
  queryClient,
  savedAssistantId,
}: {
  identity: IdentityGetResponse;
  queryClient: QueryClient;
  savedAssistantId: string;
}): void {
  queryClient.setQueryData(
    assistantIdentityQueryKey(savedAssistantId),
    identity,
  );
  if (
    useResolvedAssistantsStore.getState().activeAssistantId !== savedAssistantId
  ) {
    return;
  }

  useAssistantIdentityStore
    .getState()
    .setIdentity(identity.name, identity.version);
}
