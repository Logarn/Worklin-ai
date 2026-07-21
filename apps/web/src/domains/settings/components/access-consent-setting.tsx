import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";
import { Toggle } from "@vellumai/design-library/components/toggle";

import {
  getAssistantAccessConsent,
  updateAssistantAccessConsent,
} from "@/domains/settings/api/assistant-access-consent";
import {
  useActiveAssistantIsPlatformHosted,
  useActiveAssistantLifecycleIsLoading,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { ApiError } from "@/utils/api-errors";

function loadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return "This setting is not available for the selected assistant.";
  }
  if (error instanceof ApiError && error.status === 403) {
    return "Only the assistant owner or a workspace admin can manage admin data access.";
  }
  return "Could not load this setting. Check your connection and try again.";
}

function updateErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return "Only the assistant owner or a workspace admin can change this setting.";
  }
  return "Could not save this setting. Your previous choice is still active.";
}

export function AccessConsentSetting() {
  // platformHostedOnly: this consent toggle is per-assistant — Worklin
  // admins cannot reach a self-hosted daemon, so the setting has no
  // meaning whenever the active assistant is self-hosted. The standard
  // gate would still show it for a logged-in platform session pointed
  // at a self-hosted assistant.
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  // The privacy page is not mounted under `<ActiveAssistantGate>`, so on
  // a fresh deep-link the lifecycle is still in `{ kind: "loading" }`
  // when we render — during that window the gate returns `"full"`
  // (intentionally, to avoid UI flicker on the surrounding card). Pair
  // it with a strict "positively resolved as platform-hosted" check so
  // the retrieve query doesn't fire until lifecycle has projected a
  // platform-hosted assistant.
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  // Race-window indicator used for the spinner UX only. Narrow to
  // `kind: "loading"` so already-resolved non-hosted lifecycle states
  // (`retired`, `error`) don't show a
  // permanent spinner — they should fall through to the disabled-toggle
  // empty state below.
  const isLifecycleLoading = useActiveAssistantLifecycleIsLoading();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const isOrgReady = useIsOrgReady();
  const queryClient = useQueryClient();
  const queryKey = ["assistant-access-consent", assistantId] as const;

  const { data, error, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: () => getAssistantAccessConsent(assistantId!),
    enabled:
      platformGate === "full" &&
      isPlatformHosted &&
      isOrgReady &&
      assistantId !== null,
    retry: false,
  });

  const updateConsent = useMutation({
    mutationFn: ({
      targetAssistantId,
      next,
    }: {
      targetAssistantId: string;
      next: boolean;
    }) => {
      return updateAssistantAccessConsent(targetAssistantId, next);
    },
    onSuccess: (updated, variables) => {
      queryClient.setQueryData(
        ["assistant-access-consent", variables.targetAssistantId],
        updated,
      );
      toast.success(
        updated.access_consented
          ? "Admin data access enabled."
          : "Admin data access disabled.",
      );
    },
    onError: (mutationError) => {
      toast.error(updateErrorMessage(mutationError));
    },
  });

  // Early return must follow every hook above so gate transitions
  // (e.g. lifecycle flipping to `self_hosted` after the API resolves)
  // never skip a hook and trigger a hook-order violation. The trailing
  // divider in `privacy-page.tsx` is also gated on the same condition
  // so the layout doesn't render two adjacent dividers.
  if (platformGate === "gated") return null;

  // `isResolving` controls the spinner adjacent to the toggle, NOT the
  // toggle's disabled state. The `disabled` predicate stays strict on
  // `!isPlatformHosted` — that catches the click during both the
  // deep-link race AND already-resolved non-hosted states where the
  // mutation has no meaning. `isResolving` is narrowed to the genuine
  // lifecycle-loading window so the spinner doesn't get stuck in
  // `retired` / `error`, where the
  // toggle correctly stays disabled and the UI should look like the
  // empty/error state, not "we're still figuring this out."
  const isResolving = platformGate === "full" && isLifecycleLoading;
  const checked = data?.access_consented ?? false;
  const disabled =
    platformGate !== "full" ||
    !isPlatformHosted ||
    !isOrgReady ||
    !assistantId ||
    isLoading ||
    isError ||
    data?.can_update === false ||
    updateConsent.isPending;
  const visibleError = isError
    ? loadErrorMessage(error)
    : updateConsent.isError
      ? updateErrorMessage(updateConsent.error)
      : null;

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="text-body-medium-default text-[var(--content-default)]">
            Allow admin access to assistant data
          </div>
          <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
            Lets Worklin administrators reach privileged data on your assistant
            pod for debugging — today this means tailing the daily assistant log
            at{" "}
            <code className="rounded bg-[var(--surface-base)] px-1.5 font-mono text-[var(--content-secondary)] dark:bg-[var(--surface-lift)] dark:text-[var(--content-default)]">
              /workspace/data/logs/assistant-YYYY-MM-DD.log
            </code>
            . Off by default. Turn on temporarily when asking support to
            investigate an issue, then turn off when you&apos;re done.
          </p>
          {platformGate === "full" && visibleError && (
            <div
              className="mt-1 text-body-small-default text-[var(--system-negative-strong)]"
              role="alert"
            >
              <span>{visibleError}</span>
              {isError && (
                <button
                  type="button"
                  className="ml-2 underline underline-offset-2 hover:no-underline disabled:opacity-50"
                  disabled={isFetching}
                  onClick={() => void refetch()}
                >
                  Try again
                </button>
              )}
            </div>
          )}
          {platformGate === "full" && data?.can_update === false && (
            <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
              Only the assistant owner or a workspace admin can change this
              setting.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {platformGate === "disabled" ? null : (
            <>
              {(updateConsent.isPending || isResolving || isFetching) && (
                <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
              )}
              <Toggle
                checked={checked}
                disabled={disabled}
                onChange={() => {
                  if (!assistantId) return;
                  updateConsent.mutate({
                    targetAssistantId: assistantId,
                    next: !checked,
                  });
                }}
              />
            </>
          )}
        </div>
      </div>
      {platformGate === "disabled" && (
        <Notice tone="info" className="mt-3">
          Log in to the Worklin platform to manage admin data access.
        </Notice>
      )}
    </div>
  );
}
