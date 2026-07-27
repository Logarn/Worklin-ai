import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useManagedInferenceCapability } from "@/assistant/managed-inference-availability";
import { repairUnavailableManagedProfile } from "@/assistant/provider-profile-repair";
import { configGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { captureError } from "@/lib/sentry/capture-error";

/**
 * Repairs a stale managed active profile once an active daemon explicitly
 * reports that managed inference is unavailable. The repair is conservative:
 * it only selects an already usable personal provider when the choice is
 * unambiguous, and never changes a real managed installation.
 */
export function useManagedProviderProfileRepair(
  assistantId: string | null,
  enabled: boolean,
  repairProfile = repairUnavailableManagedProfile,
): void {
  const queryClient = useQueryClient();
  const { notConfigured } = useManagedInferenceCapability(
    assistantId,
    enabled,
  );
  const attemptedAssistantIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled || !assistantId || !notConfigured) return;
    if (attemptedAssistantIdsRef.current.has(assistantId)) return;
    attemptedAssistantIdsRef.current.add(assistantId);

    void repairProfile(assistantId)
      .then((result) => {
        if (!result.repaired) return;
        void queryClient.invalidateQueries({
          queryKey: configGetQueryKey({
            path: { assistant_id: assistantId },
          }),
        });
      })
      .catch((error: unknown) => {
        captureError(error, {
          context: "repair_unavailable_managed_profile",
        });
      });
  }, [assistantId, enabled, notConfigured, queryClient, repairProfile]);
}
