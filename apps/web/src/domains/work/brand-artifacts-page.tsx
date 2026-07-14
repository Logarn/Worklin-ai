import {
  AppWindow,
  Archive,
  BookOpenText,
  Boxes,
  ChevronLeft,
  Ellipsis,
  FileText,
  FolderInput,
  Image,
  Loader2,
  MessageSquarePlus,
  Palette,
  Search,
  Share2,
  Star,
  StarOff,
  TriangleAlert,
  Video,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { PageShell } from "@/components/page-shell";
import {
  artifactsGetQueryKey,
  brandsGetQueryKey,
  useArtifactsByIdPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { ArtifactsByIdPatchData } from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { useConversationStore } from "@/stores/conversation-store";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import { useViewerStore } from "@/stores/viewer-store";
import { createDraftConversationId } from "@/utils/conversation-selection";
import { formatFriendlyDate } from "@/utils/format-date";
import { routes } from "@/utils/routes";
import { Button, Input, Menu, toast } from "@vellumai/design-library";

import {
  artifactMatchesFilter,
  getArtifactDestination,
  getArtifactDetail,
  getArtifactDisplayFilter,
  type ArtifactDisplayFilter,
  type RegistryArtifact,
} from "./artifact-display";
import { UNASSIGNED_BRAND_ID, useWorkData } from "./use-work-data";

const FILTERS = [
  "all",
  "copy",
  "design",
  "images",
  "video",
  "social",
  "apps",
  "documents",
] as const;
type ArtifactFilter = (typeof FILTERS)[number];

const FILTER_LABELS: Record<ArtifactFilter, string> = {
  all: "All",
  copy: "Copy",
  design: "Design",
  images: "Images",
  video: "Video",
  social: "Social",
  apps: "Apps",
  documents: "Documents",
};

export function BrandArtifactsPage() {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();
  const { brandId = UNASSIGNED_BRAND_ID } = useParams();
  const navigate = useNavigate();
  const setTopBarCenter = useChatLayoutSlotsStore.use.setTopBarCenter();
  const pinnedAppIds = usePinnedAppsStore.use.pinnedAppIds();
  const togglePin = usePinnedAppsStore.use.togglePin();
  const {
    apps,
    artifacts,
    brands,
    copybookDetails,
    isLoading,
    hasPartialError,
  } = useWorkData(assistantId);
  const [filter, setFilter] = useState<ArtifactFilter>("all");
  const [searchText, setSearchText] = useState("");
  const brand = brands.find((item) => item.id === brandId);
  const brandName =
    brand?.name ??
    (brandId === UNASSIGNED_BRAND_ID ? "Unassigned" : "Artifacts");

  useEffect(() => {
    window.localStorage.setItem("worklin:last-artifact-brand", brandId);
    setTopBarCenter(
      <span className="text-title-small text-[var(--content-default)]">
        {brandName}
      </span>,
    );
    return () => setTopBarCenter(null);
  }, [brandId, brandName, setTopBarCenter]);

  const normalizedSearch = searchText.trim().toLowerCase();
  const patchArtifact = useArtifactsByIdPatchMutation();
  const refreshArtifacts = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: artifactsGetQueryKey({
          path: { assistant_id: assistantId },
          query: { status: "active" },
        }),
      }),
      queryClient.invalidateQueries({
        queryKey: brandsGetQueryKey({ path: { assistant_id: assistantId } }),
      }),
    ]);
  };
  const updateArtifact = async (
    artifact: RegistryArtifact,
    body: ArtifactsByIdPatchData["body"],
    successMessage: string,
  ) => {
    try {
      await patchArtifact.mutateAsync({
        path: { assistant_id: assistantId, id: artifact.id },
        body,
      });
      await refreshArtifacts();
      toast.success(successMessage);
    } catch (error) {
      captureError(error, { context: "artifact_organization_update" });
      toast.error("Artifact could not be updated");
    }
  };
  const visibleCopybooks = useMemo(
    () =>
      copybookDetails.filter(
        (detail) =>
          (detail.brand?.id ?? detail.copybook.brandId) === brandId &&
          (filter === "all" || filter === "copy") &&
          (!normalizedSearch ||
            detail.copybook.title.toLowerCase().includes(normalizedSearch)),
      ),
    [brandId, copybookDetails, filter, normalizedSearch],
  );
  const registeredAppIds = useMemo(
    () =>
      new Set(
        artifacts
          .filter((artifact) => artifact.resourceType === "app")
          .map((artifact) => artifact.resourceId),
      ),
    [artifacts],
  );
  const visibleApps = useMemo(
    () =>
      brandId === UNASSIGNED_BRAND_ID && (filter === "all" || filter === "apps")
        ? apps.filter(
            (app) =>
              !registeredAppIds.has(app.id) &&
              (!normalizedSearch ||
                app.name.toLowerCase().includes(normalizedSearch) ||
                app.description?.toLowerCase().includes(normalizedSearch)),
          )
        : [],
    [apps, brandId, filter, normalizedSearch, registeredAppIds],
  );
  const copybookDocumentIds = useMemo(
    () =>
      new Set(
        copybookDetails.flatMap((detail) =>
          detail.months.flatMap((month) =>
            month.documentSurfaceId ? [month.documentSurfaceId] : [],
          ),
        ),
      ),
    [copybookDetails],
  );
  const copybookResourceIds = useMemo(
    () => new Set(copybookDetails.map((detail) => detail.copybook.id)),
    [copybookDetails],
  );
  const visibleRegistryArtifacts = useMemo(
    () =>
      artifacts.filter((artifact) => {
        const artifactBrandId = artifact.brandId ?? UNASSIGNED_BRAND_ID;
        if (artifactBrandId !== brandId || artifact.parentArtifactId) return false;
        if (
          artifact.resourceType === "copybook" &&
          copybookResourceIds.has(artifact.resourceId)
        ) {
          return false;
        }
        if (
          artifact.resourceType === "document" &&
          copybookDocumentIds.has(artifact.resourceId)
        ) {
          return false;
        }
        if (!artifactMatchesFilter(artifact, filter as ArtifactDisplayFilter)) {
          return false;
        }
        return (
          !normalizedSearch ||
          artifact.title.toLowerCase().includes(normalizedSearch) ||
          artifact.artifactType.toLowerCase().includes(normalizedSearch)
        );
      }),
    [
      artifacts,
      brandId,
      copybookDocumentIds,
      copybookResourceIds,
      filter,
      normalizedSearch,
    ],
  );
  const resultCount =
    visibleCopybooks.length + visibleApps.length + visibleRegistryArtifacts.length;

  const startWithWorklin = () => {
    const draftConversationId = createDraftConversationId();
    useConversationStore
      .getState()
      .setActiveConversationId(draftConversationId);
    useViewerStore.getState().setMainView("chat");
    const prompt = `Create a new artifact for ${brandName}. Ask what I want to make, then keep it organized under this brand.`;
    void navigate(
      `${routes.conversation(draftConversationId)}?prompt=${encodeURIComponent(prompt)}`,
    );
  };

  if (isLoading) {
    return (
      <PageShell className="items-center justify-center">
        <Loader2 className="size-5 animate-spin text-[var(--content-tertiary)]" />
      </PageShell>
    );
  }

  return (
    <PageShell className="overflow-hidden p-0">
      <div className="flex h-full min-w-0 flex-col">
        <header className="shrink-0 border-b border-[var(--border-base)] px-5 py-5 md:px-8">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-start justify-between gap-4">
            <div>
              <Link
                to={routes.work.root}
                className="inline-flex items-center gap-1 text-body-small-default text-[var(--content-tertiary)] hover:text-[var(--content-secondary)]"
              >
                <ChevronLeft className="size-4" />
                All brands
              </Link>
              <h1 className="mt-2 text-title-large text-[var(--content-emphasised)]">
                {brandName}
              </h1>
              <p className="mt-1 text-body-small-default text-[var(--content-tertiary)]">
                Artifacts
              </p>
            </div>
            <button
              type="button"
              onClick={startWithWorklin}
              className="inline-flex items-center gap-2 rounded-md bg-[var(--primary-base)] px-3 py-2 text-body-small-default text-[var(--content-inset)] hover:bg-[var(--primary-hover)]"
            >
              <MessageSquarePlus className="size-4" />
              Create with Worklin
            </button>
          </div>
          <div className="mx-auto mt-5 flex w-full max-w-6xl flex-col gap-3">
            <Input
              fullWidth
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="Search artifacts"
              leftIcon={<Search className="size-4" />}
            />
            <div
              className="flex gap-2 overflow-x-auto pb-1"
              role="tablist"
              aria-label="Artifact type"
            >
              {FILTERS.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={filter === item}
                  onClick={() => setFilter(item)}
                  className={`shrink-0 rounded-full border px-3 py-1.5 text-body-small-default transition-colors ${
                    filter === item
                      ? "border-[var(--primary-base)] bg-[var(--primary-soft)] text-[var(--content-emphasised)]"
                      : "border-[var(--border-base)] text-[var(--content-secondary)] hover:bg-[var(--surface-hover)]"
                  }`}
                >
                  {FILTER_LABELS[item]}
                </button>
              ))}
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-6 md:px-8">
          <div className="mx-auto w-full max-w-6xl">
            {hasPartialError ? (
              <div className="mb-5 rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)] px-4 py-3 text-body-small-default text-[var(--content-secondary)]">
                Some artifact sources are temporarily unavailable. Available
                artifacts are shown.
              </div>
            ) : null}

            {resultCount === 0 ? (
              <ArtifactEmptyState
                filter={filter}
                hasSearch={normalizedSearch.length > 0}
              />
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {visibleCopybooks.map((detail) => {
                  const registryArtifact = artifacts.find(
                    (artifact) =>
                      artifact.resourceType === "copybook" &&
                      artifact.resourceId === detail.copybook.id,
                  );
                  const firstMonth = [...detail.months].sort(
                    (a, b) => a.month - b.month,
                  )[0];
                  const campaignCount = detail.months.reduce(
                    (total, month) => total + month.campaigns.length,
                    0,
                  );
                  const destination = firstMonth
                    ? routes.work.copybookMonth(
                        brandId,
                        detail.copybook.id,
                        detail.copybook.year,
                        firstMonth.month,
                      )
                    : null;
                  return (
                    <ArtifactCard
                      key={detail.copybook.id}
                      icon={<BookOpenText className="size-6" />}
                      eyebrow="COPYBOOK"
                      title={detail.copybook.title}
                      detail={`${detail.months.length} months · ${campaignCount} campaigns`}
                      updatedAt={detail.copybook.updatedAt}
                      to={destination ?? undefined}
                      onClick={destination ? undefined : startWithWorklin}
                      favorite={registryArtifact?.favorite}
                      actions={
                        registryArtifact ? (
                          <ArtifactActionsMenu
                            artifact={registryArtifact}
                            brands={brands}
                            disabled={patchArtifact.isPending}
                            onUpdate={updateArtifact}
                          />
                        ) : undefined
                      }
                    />
                  );
                })}
                {visibleApps.map((app) => (
                  <ArtifactCard
                    key={app.id}
                    icon={<AppWindow className="size-6" />}
                    eyebrow={pinnedAppIds.has(app.id) ? "FAVORITE APP" : "APP"}
                    title={app.name}
                    detail={app.description ?? "Interactive artifact"}
                    updatedAt={app.updatedAt}
                    to={routes.work.app(brandId, app.id)}
                    favorite={pinnedAppIds.has(app.id)}
                    actions={
                      <LocalAppActionsMenu
                        favorite={pinnedAppIds.has(app.id)}
                        onToggleFavorite={() => togglePin(app)}
                      />
                    }
                  />
                ))}
                {visibleRegistryArtifacts.map((artifact) => (
                  <ArtifactCard
                    key={artifact.id}
                    icon={<ArtifactTypeIcon artifact={artifact} />}
                    eyebrow={artifact.artifactType.replaceAll("_", " ").toUpperCase()}
                    title={artifact.title}
                    detail={getArtifactDetail(artifact)}
                    updatedAt={artifact.updatedAt}
                    to={getArtifactDestination(artifact, brandId)}
                    favorite={artifact.favorite}
                    unavailable={!artifact.sourceExists}
                    actions={
                      <ArtifactActionsMenu
                        artifact={artifact}
                        brands={brands}
                        disabled={patchArtifact.isPending}
                        onUpdate={updateArtifact}
                      />
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </PageShell>
  );
}

function ArtifactEmptyState({
  filter,
  hasSearch,
}: {
  filter: ArtifactFilter;
  hasSearch: boolean;
}) {
  const icons: Record<ArtifactFilter, typeof Archive> = {
    all: Archive,
    copy: BookOpenText,
    design: Palette,
    images: Image,
    video: Video,
    social: Share2,
    apps: AppWindow,
    documents: FileText,
  };
  const Icon = icons[filter];
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <span className="flex size-12 items-center justify-center rounded-xl bg-[var(--surface-lift)] text-[var(--content-tertiary)]">
        <Icon className="size-6" />
      </span>
      <h2 className="mt-4 text-title-small text-[var(--content-emphasised)]">
        {hasSearch
          ? "No matching artifacts"
          : `No ${FILTER_LABELS[filter].toLowerCase()} yet`}
      </h2>
      <p className="mt-2 max-w-md text-body-small-default text-[var(--content-tertiary)]">
        {hasSearch
          ? "Try another search or artifact type."
          : "Create with Worklin and it will stay organized here."}
      </p>
    </div>
  );
}

interface ArtifactCardProps {
  icon: ReactNode;
  eyebrow: string;
  title: string;
  detail: string;
  updatedAt: number;
  to?: string;
  onClick?: () => void;
  favorite?: boolean;
  unavailable?: boolean;
  actions?: ReactNode;
}

function ArtifactCard({
  icon,
  eyebrow,
  title,
  detail,
  updatedAt,
  to,
  onClick,
  favorite = false,
  unavailable = false,
  actions,
}: ArtifactCardProps) {
  const content = (
    <>
      <span className="flex size-11 items-center justify-center rounded-lg bg-[var(--surface-lift)] text-[var(--content-secondary)]">
        {icon}
      </span>
      <span className="mt-5 flex items-center gap-1.5 text-label-small text-[var(--content-tertiary)]">
        {favorite ? (
          <Star className="size-3 fill-current" aria-label="Favorite" />
        ) : null}
        {eyebrow}
      </span>
      <span className="mt-1 line-clamp-2 text-title-small text-[var(--content-emphasised)]">
        {title}
      </span>
      <span className="mt-2 line-clamp-2 text-body-small-default text-[var(--content-tertiary)]">
        {detail}
      </span>
      <span className="mt-auto pt-5 text-body-small-default text-[var(--content-quiet)]">
        Updated {formatFriendlyDate(new Date(updatedAt))}
      </span>
    </>
  );
  return (
    <li className="group relative min-h-60">
      {to ? (
        <Link
          to={to}
          className="flex h-full flex-col rounded-xl border border-[var(--border-base)] bg-[var(--surface-base)] p-5 transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        >
          {content}
        </Link>
      ) : onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="flex h-full w-full flex-col rounded-xl border border-[var(--border-base)] bg-[var(--surface-base)] p-5 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        >
          {content}
        </button>
      ) : (
        <div
          className="flex h-full flex-col rounded-xl border border-[var(--border-base)] bg-[var(--surface-base)] p-5"
          aria-label={unavailable ? `${title}, source unavailable` : title}
        >
          {content}
        </div>
      )}
      {actions ? (
        <div className="absolute right-3 top-3 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100 md:group-focus-within:opacity-100">
          {actions}
        </div>
      ) : null}
    </li>
  );
}

function ArtifactTypeIcon({ artifact }: { artifact: RegistryArtifact }) {
  if (!artifact.sourceExists) return <TriangleAlert className="size-6" />;
  const iconByFilter: Record<
    Exclude<ReturnType<typeof getArtifactDisplayFilter>, "other">,
    typeof FileText
  > = {
    copy: BookOpenText,
    design: Palette,
    images: Image,
    video: Video,
    social: Share2,
    apps: AppWindow,
    documents: FileText,
  };
  const filter = getArtifactDisplayFilter(artifact);
  const Icon = filter === "other" ? Boxes : iconByFilter[filter];
  return <Icon className="size-6" />;
}

interface ArtifactActionsMenuProps {
  artifact: RegistryArtifact;
  brands: Array<{ id: string; name: string }>;
  disabled: boolean;
  onUpdate: (
    artifact: RegistryArtifact,
    body: ArtifactsByIdPatchData["body"],
    successMessage: string,
  ) => Promise<void>;
}

function ArtifactActionsMenu({
  artifact,
  brands,
  disabled,
  onUpdate,
}: ArtifactActionsMenuProps) {
  const currentBrandId = artifact.brandId ?? UNASSIGNED_BRAND_ID;
  const brandChoices = [
    ...brands.filter((brand) => brand.id !== UNASSIGNED_BRAND_ID),
    { id: UNASSIGNED_BRAND_ID, name: "Unassigned" },
  ].filter((brand) => brand.id !== currentBrandId);

  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <Button
          variant="outlined"
          size="compact"
          iconOnly={<Ellipsis />}
          aria-label={`Actions for ${artifact.title}`}
          disabled={disabled}
          onClick={(event) => event.stopPropagation()}
        />
      </Menu.Trigger>
      <Menu.Content align="end" sideOffset={4}>
        <Menu.Item
          leftIcon={
            artifact.favorite ? (
              <StarOff className="size-3.5" />
            ) : (
              <Star className="size-3.5" />
            )
          }
          onSelect={() =>
            void onUpdate(
              artifact,
              { favorite: !artifact.favorite },
              artifact.favorite ? "Removed from favorites" : "Added to favorites",
            )
          }
        >
          {artifact.favorite ? "Remove favorite" : "Favorite"}
        </Menu.Item>
        {brandChoices.length > 0 ? (
          <Menu.Sub>
            <Menu.SubTrigger leftIcon={<FolderInput className="size-3.5" />}>
              Move to brand
            </Menu.SubTrigger>
            <Menu.SubContent>
              {brandChoices.map((brand) => (
                <Menu.Item
                  key={brand.id}
                  onSelect={() =>
                    void onUpdate(
                      artifact,
                      {
                        brandId:
                          brand.id === UNASSIGNED_BRAND_ID ? null : brand.id,
                      },
                      `Moved to ${brand.name}`,
                    )
                  }
                >
                  {brand.name}
                </Menu.Item>
              ))}
            </Menu.SubContent>
          </Menu.Sub>
        ) : null}
        <Menu.Separator />
        <Menu.Item
          leftIcon={<Archive className="size-3.5" />}
          onSelect={() =>
            void onUpdate(artifact, { archived: true }, "Artifact archived")
          }
        >
          Archive
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}

function LocalAppActionsMenu({
  favorite,
  onToggleFavorite,
}: {
  favorite: boolean;
  onToggleFavorite: () => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <Button
          variant="outlined"
          size="compact"
          iconOnly={<Ellipsis />}
          aria-label="App actions"
          onClick={(event) => event.stopPropagation()}
        />
      </Menu.Trigger>
      <Menu.Content align="end" sideOffset={4}>
        <Menu.Item
          leftIcon={
            favorite ? (
              <StarOff className="size-3.5" />
            ) : (
              <Star className="size-3.5" />
            )
          }
          onSelect={onToggleFavorite}
        >
          {favorite ? "Remove favorite" : "Favorite"}
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}
