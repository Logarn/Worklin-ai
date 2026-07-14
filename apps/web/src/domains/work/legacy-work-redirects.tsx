import { Loader2 } from "lucide-react";
import { Navigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { PageShell } from "@/components/page-shell";
import { copybooksByIdGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { routes } from "@/utils/routes";

import { UNASSIGNED_BRAND_ID } from "./use-work-data";

export function LegacyLibraryRedirectPage() {
  return <Navigate replace to={routes.work.root} />;
}

export function LegacyLibraryAppRedirectPage() {
  const { appId = "" } = useParams();
  return <Navigate replace to={routes.work.app(UNASSIGNED_BRAND_ID, appId)} />;
}

export function LegacyCopybookRedirectPage() {
  const assistantId = useActiveAssistantId();
  const { copybookId = "", year = "", month = "" } = useParams();
  const query = useQuery(
    copybooksByIdGetOptions({
      path: { assistant_id: assistantId, id: copybookId },
    }),
  );

  if (query.isPending) {
    return (
      <PageShell className="items-center justify-center">
        <Loader2 className="size-5 animate-spin text-[var(--content-tertiary)]" />
      </PageShell>
    );
  }

  if (!query.data) {
    return <Navigate replace to={routes.work.root} />;
  }

  return (
    <Navigate
      replace
      to={routes.work.copybookMonth(
        query.data.brand?.id ?? query.data.copybook.brandId,
        copybookId,
        Number(year),
        Number(month),
      )}
    />
  );
}
