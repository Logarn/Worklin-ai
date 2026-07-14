import { Archive, ArrowRight, Boxes, FolderOpen, Loader2 } from "lucide-react";
import { useEffect } from "react";
import { Link, Navigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { PageShell } from "@/components/page-shell";
import { routes } from "@/utils/routes";

import { useWorkData } from "./use-work-data";

const LAST_BRAND_KEY = "worklin:last-artifact-brand";

export function WorkPage() {
  const assistantId = useActiveAssistantId();
  const setTopBarCenter = useChatLayoutSlotsStore.use.setTopBarCenter();
  const { brands, isLoading, hasPartialError } = useWorkData(assistantId);

  useEffect(() => {
    setTopBarCenter(
      <span className="text-title-small text-[var(--content-default)]">
        Work
      </span>,
    );
    return () => setTopBarCenter(null);
  }, [setTopBarCenter]);

  if (isLoading) {
    return (
      <PageShell className="items-center justify-center">
        <Loader2 className="size-5 animate-spin text-[var(--content-tertiary)]" />
      </PageShell>
    );
  }

  if (brands.length === 1) {
    return <Navigate replace to={routes.work.brandArtifacts(brands[0].id)} />;
  }

  return (
    <PageShell className="overflow-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col py-2">
        <div className="border-b border-[var(--border-base)] pb-6">
          <p className="text-label-small text-[var(--content-tertiary)]">
            WORK
          </p>
          <h1 className="mt-2 text-title-large text-[var(--content-emphasised)]">
            Choose a brand
          </h1>
          <p className="mt-2 max-w-2xl text-body-small-default text-[var(--content-tertiary)]">
            Every copybook, document, app, design, image, and campaign asset
            lives with its brand.
          </p>
        </div>

        {hasPartialError ? (
          <div className="mt-5 rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] px-4 py-3 text-body-small-default text-[var(--content-secondary)]">
            Some artifact sources are temporarily unavailable. Available work is
            shown below.
          </div>
        ) : null}

        {brands.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center py-24 text-center">
            <Boxes className="size-10 text-[var(--content-tertiary)]" />
            <h2 className="mt-4 text-title-small text-[var(--content-emphasised)]">
              Your work will appear here
            </h2>
            <p className="mt-2 max-w-md text-body-small-default text-[var(--content-tertiary)]">
              Ask Worklin to create a campaign copybook or another artifact for
              a brand.
            </p>
          </div>
        ) : (
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {brands.map((brand) => (
              <li key={brand.id}>
                <Link
                  to={routes.work.brandArtifacts(brand.id)}
                  className="group flex min-h-44 flex-col rounded-xl border border-[var(--border-base)] bg-[var(--surface-base)] p-5 transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                  onClick={() =>
                    window.localStorage.setItem(LAST_BRAND_KEY, brand.id)
                  }
                >
                  <span className="flex items-start justify-between gap-3">
                    <span className="flex size-10 items-center justify-center rounded-lg bg-[var(--surface-lift)] text-[var(--content-secondary)]">
                      {brand.id === "unassigned" ? (
                        <Archive className="size-5" />
                      ) : (
                        <FolderOpen className="size-5" />
                      )}
                    </span>
                    <ArrowRight className="size-4 text-[var(--content-tertiary)] transition-transform group-hover:translate-x-0.5" />
                  </span>
                  <span className="mt-5 text-title-small text-[var(--content-emphasised)]">
                    {brand.name}
                  </span>
                  <span className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
                    {brand.artifactCount}{" "}
                    {brand.artifactCount === 1 ? "artifact" : "artifacts"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </PageShell>
  );
}
