import { Loader2 } from "lucide-react";
import { Outlet, useNavigate } from "react-router";

import { Typography } from "@vellumai/design-library";
import { Button } from "@vellumai/design-library/components/button";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { lifecycleService } from "@/assistant/lifecycle-service";
import type { AssistantState } from "@/assistant/types";
import { handleLogout } from "@/lib/auth/handle-logout";
import { isLocalMode } from "@/lib/local-mode";
import { useHasPlatformSession } from "@/stores/auth-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/**
 * Layout route that defers rendering of its child `<Outlet />` until
 * the assistant lifecycle has resolved: the selection store has a
 * non-null `activeAssistantId` AND the lifecycle store reports
 * `assistantState.kind` is `"active"` or `"self_hosted"`. Until both
 * are true a placeholder is rendered.
 *
 * Without this gate, every route that reads `activeAssistantId` from
 * the store and feeds it to a `useQuery` (e.g. home, identity,
 * library, workspace, contacts, intelligence) suffers a
 * silent-degradation bug on cold navigation: the query stays
 * `enabled: false`, `isLoading` is false, and the page renders its
 * fully-empty fallback state instead of waiting for the lifecycle to
 * resolve.
 *
 * Inside this gate, child routes use `useActiveAssistantId()` from
 * `@/assistant/use-active-assistant-id` to read a non-null
 * `assistantId: string`. Non-gated routes (`ChatPage`,
 * `DocumentViewerPage`) intentionally render across pre-active
 * lifecycle states and read `useResolvedAssistantsStore.use.activeAssistantId()`
 * directly, handling the null case themselves.
 */
export function ActiveAssistantGate() {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantStateKind = useAssistantLifecycleStore(
    (s) => s.assistantState.kind,
  );

  if (
    !assistantId ||
    (assistantStateKind !== "active" && assistantStateKind !== "self_hosted")
  ) {
    return <ActiveAssistantPlaceholder />;
  }

  return <Outlet />;
}

function ActiveAssistantPlaceholder() {
  const navigate = useNavigate();
  const assistantState = useAssistantLifecycleStore.use.assistantState();
  // Keep an escape hatch reachable while the assistant lifecycle is
  // unresolved: hide in pure local mode unless a platform session exists.
  const hasPlatformSession = useHasPlatformSession();
  const showLogout = !isLocalMode() || hasPlatformSession;

  if (assistantState.kind === "error") {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[var(--app-spacing-md)] px-6 text-center text-[var(--content-default)]"
        role="alert"
      >
        <Typography variant="title-small" as="h1">
          Worklin couldn&apos;t finish connecting
        </Typography>
        <Typography
          variant="body-medium-default"
          className="max-w-md text-[var(--content-tertiary)]"
        >
          {assistantState.message}
        </Typography>
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            variant="primary"
            onClick={() => void lifecycleService.retryAssistant()}
          >
            Try again
          </Button>
          {showLogout && (
            <Button variant="ghost" onClick={() => void handleLogout(navigate)}>
              Log Out
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[var(--app-spacing-md)] text-[var(--content-tertiary)]"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-6 animate-spin" aria-hidden="true" />
      <Typography variant="body-medium-default">
        {assistantLoadingMessage(assistantState)}
      </Typography>
      {showLogout && (
        <Button variant="ghost" onClick={() => void handleLogout(navigate)}>
          Log Out
        </Button>
      )}
    </div>
  );
}

function assistantLoadingMessage(state: AssistantState): string {
  switch (state.kind) {
    case "cleaning_up":
      return "Finishing a workspace update…";
    case "initializing":
      return "Preparing your Worklin…";
    default:
      return "Connecting to your Worklin…";
  }
}
