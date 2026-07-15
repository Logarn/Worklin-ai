import { Button } from "@vellumai/design-library/components/button";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { PageShell } from "@/components/page-shell";

import { acceptArtifactInvitation } from "./artifact-sharing-api";

export function AcceptArtifactInvitationPage() {
  const { token = "" } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void acceptArtifactInvitation(token)
      .then((result) => {
        if (!cancelled)
          void navigate(
            `/assistant/shared/${encodeURIComponent(result.artifactId)}`,
            { replace: true },
          );
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "This invitation could not be opened.",
          );
          setPending(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, token]);

  return (
    <PageShell className="items-center justify-center gap-4 p-6 text-center">
      {pending ? (
        <Loader2 className="size-5 animate-spin text-[var(--content-tertiary)]" />
      ) : null}
      <div className="max-w-sm space-y-2">
        <h1 className="m-0 text-title-medium text-[var(--content-emphasised)]">
          {pending ? "Opening shared work…" : "This invite is unavailable"}
        </h1>
        {error ? (
          <p className="m-0 text-body-small-default text-[var(--content-tertiary)]">
            {error}
          </p>
        ) : null}
      </div>
      {!pending ? (
        <Button
          variant="outlined"
          onClick={() => void navigate("/assistant/work")}
        >
          Go to Work
        </Button>
      ) : null}
    </PageShell>
  );
}
