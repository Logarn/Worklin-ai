import { Loader2, RotateCcw } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router";

import { Button } from "@vellumai/design-library/components/button";
import { toast } from "@vellumai/design-library/components/toast";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { AppViewerContainer } from "@/components/app-viewer-container";
import { appsByIdOpenPost } from "@/generated/daemon/sdk.gen";
import { useEditApp } from "@/hooks/use-edit-app";
import { primeAppHtmlCache } from "@/utils/app-html-cache";
import { routes } from "@/utils/routes";
import { shareApp } from "@/utils/share-app";

interface LoadedApp {
  appId: string;
  dirName?: string;
  name: string;
  html: string;
}

const APP_OPEN_ERROR =
  "This app could not be opened. It may have been deleted, or your assistant may be temporarily unavailable.";

function WorkAppState({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] px-6 py-5 text-center">
      {children}
    </div>
  );
}

export function WorkAppPage() {
  const { appId, brandId = "unassigned" } = useParams<{
    appId: string;
    brandId: string;
  }>();
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();

  const [app, setApp] = useState<LoadedApp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isSharing, setIsSharing] = useState(false);
  const requestRef = useRef<string | null>(null);

  useEffect(() => {
    if (!appId) {
      setError("This app link is incomplete.");
      return;
    }

    const requestKey = `${assistantId}:${appId}:${loadAttempt}`;
    requestRef.current = requestKey;
    setApp(null);
    setError(null);

    appsByIdOpenPost({
      path: { assistant_id: assistantId, id: appId },
      throwOnError: true,
    })
      .then(({ data: result }) => {
        if (requestRef.current !== requestKey) return;
        primeAppHtmlCache(assistantId, result.appId, result.html);
        setApp({
          appId: result.appId,
          dirName: result.dirName,
          name: result.name,
          html: result.html,
        });
      })
      .catch(() => {
        if (requestRef.current !== requestKey) return;
        setError(APP_OPEN_ERROR);
      });

    return () => {
      if (requestRef.current === requestKey) requestRef.current = null;
    };
  }, [assistantId, appId, loadAttempt]);

  const handleClose = useCallback(() => {
    void navigate(routes.work.brandArtifacts(brandId));
  }, [brandId, navigate]);

  const editApp = useEditApp();
  const handleEdit = useCallback(() => {
    if (app) editApp(app);
  }, [app, editApp]);

  const handleShare = useCallback(async () => {
    if (!app || isSharing) return;
    setIsSharing(true);
    try {
      await shareApp(assistantId, app.appId, app.name);
      toast.success("App exported", { description: `${app.name}.vellum` });
    } catch (shareError) {
      toast.error("Failed to share app", {
        description:
          shareError instanceof Error ? shareError.message : undefined,
      });
    } finally {
      setIsSharing(false);
    }
  }, [assistantId, app, isSharing]);

  if (error) {
    return (
      <WorkAppState>
        <h1 className="text-title-small text-[var(--content-emphasised)]">
          App could not open
        </h1>
        <p className="mt-2 max-w-md text-body-small-default text-[var(--content-tertiary)]">
          {error}
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {appId ? (
            <Button
              variant="outlined"
              leftIcon={<RotateCcw />}
              onClick={() => setLoadAttempt((attempt) => attempt + 1)}
            >
              Try again
            </Button>
          ) : null}
          <Button variant="primary" onClick={handleClose}>
            Back to artifacts
          </Button>
        </div>
      </WorkAppState>
    );
  }

  if (!app) {
    return (
      <WorkAppState>
        <div role="status" aria-live="polite">
          <Loader2
            className="mx-auto size-6 animate-spin text-[var(--content-tertiary)]"
            aria-hidden
          />
          <p className="mt-3 text-body-small-default text-[var(--content-secondary)]">
            Opening app...
          </p>
        </div>
      </WorkAppState>
    );
  }

  return (
    <AppViewerContainer
      appId={app.appId}
      appName={app.name}
      html={app.html}
      assistantId={assistantId}
      onClose={handleClose}
      onEdit={handleEdit}
      onShare={handleShare}
      isSharing={isSharing}
      enableFullscreen
    />
  );
}
