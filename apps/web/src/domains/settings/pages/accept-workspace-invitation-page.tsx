import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { Button } from "@vellumai/design-library/components/button";

import { PageShell } from "@/components/page-shell";
import { acceptWorkspaceInvitation } from "@/domains/settings/api/workspace";
import { useOrganizationStore } from "@/stores/organization-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

export function AcceptWorkspaceInvitationPage() {
  const { token = "" } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setError("This invitation link is incomplete.");
      return;
    }

    void acceptWorkspaceInvitation(token)
      .then(async (membership) => {
        await useOrganizationStore.getState().fetchOrganizations();
        if (cancelled) return;

        useOrganizationStore
          .getState()
          .setCurrentOrganizationId(membership.org_id);
        const assistants = useResolvedAssistantsStore.getState();
        assistants.setSelectedAssistant(null);
        assistants.setActiveAssistantId(null);
        assistants.clear();
        await navigate(routes.settings.workspace, { replace: true });
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "This invitation could not be accepted.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [navigate, token]);

  return (
    <PageShell className="items-center justify-center gap-4 p-6 text-center">
      {!error && (
        <Loader2
          className="size-5 animate-spin text-[var(--content-tertiary)]"
          aria-hidden
        />
      )}
      <div className="max-w-sm space-y-2">
        <h1 className="m-0 text-title-medium text-[var(--content-emphasised)]">
          {error ? "This invite is unavailable" : "Joining workspace..."}
        </h1>
        <p className="m-0 text-body-small-default text-[var(--content-tertiary)]">
          {error ??
            "We are adding your account and opening the shared workspace."}
        </p>
      </div>
      {error && (
        <Button
          variant="outlined"
          onClick={() => void navigate(routes.settings.workspace)}
        >
          Open my workspace
        </Button>
      )}
    </PageShell>
  );
}
