import { ChevronDown } from "lucide-react";

import { IntegrationIcon } from "@/components/integrations/integration-icon";

export type MeetingSourceStatus =
  "In development" | "Planned" | "Planned · admin setup required";

export interface MeetingSource {
  id: string;
  displayName: string;
  description: string;
  statusLabel: MeetingSourceStatus;
  recommended: boolean;
}

export const MEETING_SOURCES: readonly MeetingSource[] = [
  {
    id: "fathom",
    displayName: "Fathom",
    description:
      "Worklin will support read-only Fathom transcripts, summaries, and action items after development and security review are complete.",
    statusLabel: "In development",
    recommended: true,
  },
  {
    id: "fireflies",
    displayName: "Fireflies",
    description:
      "Worklin will support read-only Fireflies transcripts, summaries, action items, and insights.",
    statusLabel: "In development",
    recommended: true,
  },
  {
    id: "granola",
    displayName: "Granola",
    description:
      "Worklin will read meeting notes and available transcripts from an authorized Granola connection.",
    statusLabel: "Planned",
    recommended: true,
  },
  {
    id: "otter",
    displayName: "Otter",
    description:
      "Worklin will read conversations and transcripts from an authorized Otter connection.",
    statusLabel: "Planned",
    recommended: true,
  },
  {
    id: "grain",
    displayName: "Grain",
    description:
      "Worklin will bring in authorized Grain recordings, notes, action items, and transcripts.",
    statusLabel: "Planned",
    recommended: false,
  },
  {
    id: "read_ai",
    displayName: "Read AI",
    description:
      "Worklin will bring in authorized Read AI reports and completed-meeting updates.",
    statusLabel: "Planned",
    recommended: false,
  },
  {
    id: "tldv",
    displayName: "tl;dv",
    description:
      "Worklin will bring in authorized tl;dv transcripts and notes, with webhooks on supported plans.",
    statusLabel: "Planned",
    recommended: false,
  },
  {
    id: "meetgeek",
    displayName: "MeetGeek",
    description:
      "Worklin will bring in authorized MeetGeek meetings, transcripts, and highlights.",
    statusLabel: "Planned",
    recommended: false,
  },
  {
    id: "fellow",
    displayName: "Fellow",
    description:
      "Worklin will read authorized Fellow transcripts and structured collaborative notes.",
    statusLabel: "Planned",
    recommended: false,
  },
  {
    id: "notion_meeting_notes",
    displayName: "Notion AI Meeting Notes",
    description:
      "Worklin will reuse an authorized Notion connection to read accessible meeting notes.",
    statusLabel: "Planned",
    recommended: false,
  },
  {
    id: "circleback",
    displayName: "Circleback",
    description:
      "Worklin will receive selected Circleback meeting outcomes through signed automations.",
    statusLabel: "Planned",
    recommended: false,
  },
  {
    id: "google_meet",
    displayName: "Google Meet",
    description:
      "Worklin will reuse an authorized Google connection to read accessible transcripts and meeting events.",
    statusLabel: "Planned",
    recommended: false,
  },
  {
    id: "zoom",
    displayName: "Zoom",
    description:
      "Worklin will bring in authorized Zoom cloud recordings, transcripts, summaries, and meeting events.",
    statusLabel: "Planned",
    recommended: false,
  },
  {
    id: "teams",
    displayName: "Microsoft Teams",
    description:
      "Worklin will read organization-approved transcripts and meeting insights after Microsoft administrator setup.",
    statusLabel: "Planned · admin setup required",
    recommended: false,
  },
  {
    id: "supernormal",
    displayName: "Supernormal",
    description:
      "Worklin will search meeting history through a team-managed Supernormal connection.",
    statusLabel: "Planned · admin setup required",
    recommended: false,
  },
  {
    id: "krisp",
    displayName: "Krisp",
    description:
      "Worklin will receive authorized Krisp notes, transcripts, outlines, and action items after administrator setup.",
    statusLabel: "Planned · admin setup required",
    recommended: false,
  },
  {
    id: "sembly",
    displayName: "Sembly",
    description:
      "Worklin will receive authorized Sembly meeting notes, transcripts, and tasks after administrator setup.",
    statusLabel: "Planned · admin setup required",
    recommended: false,
  },
  {
    id: "jamie",
    displayName: "Jamie",
    description:
      "Worklin will search authorized Jamie meetings, tasks, and tags after administrator setup.",
    statusLabel: "Planned · admin setup required",
    recommended: false,
  },
  {
    id: "avoma",
    displayName: "Avoma",
    description:
      "Worklin will read Avoma conversation intelligence after an administrator connects the workspace.",
    statusLabel: "Planned · admin setup required",
    recommended: false,
  },
  {
    id: "gong",
    displayName: "Gong",
    description:
      "Worklin will read organization-approved Gong conversations and intelligence after administrator setup.",
    statusLabel: "Planned · admin setup required",
    recommended: false,
  },
] as const;

export function filterMeetingSources(
  searchText: string,
  selectedFilter: "all" | "enabled" | "not-enabled",
): MeetingSource[] {
  // Connection state is not unified yet, so these informational rows only
  // belong under All. This avoids calling a planned app "not enabled."
  if (selectedFilter !== "all") return [];
  const needle = searchText.trim().toLowerCase();
  const sources = [...MEETING_SOURCES].sort(
    (left, right) => Number(right.recommended) - Number(left.recommended),
  );
  if (!needle) return sources;
  return sources.filter((source) =>
    [
      source.id,
      source.displayName,
      source.description,
      source.statusLabel,
      "meeting notes",
      "meeting transcripts",
    ].some((value) => value.toLowerCase().includes(needle)),
  );
}

export function MeetingNotesSection({
  sources,
  searchActive = false,
}: {
  sources: MeetingSource[];
  searchActive?: boolean;
}) {
  if (sources.length === 0) return null;

  return (
    <section aria-labelledby="meeting-notes-heading" className="space-y-3">
      <div>
        <h2
          id="meeting-notes-heading"
          className="text-title-small text-[var(--content-default)]"
        >
          Meeting notes
        </h2>
        <p className="mt-0.5 text-body-medium-lighter text-[var(--content-tertiary)]">
          Planned read-only meeting sources, shown with their real release
          stage.
        </p>
      </div>

      <details
        open={searchActive || undefined}
        className="group overflow-hidden rounded-lg border border-[var(--border-element)] bg-[var(--surface-lift)]"
      >
        <summary
          aria-label="Meeting note apps"
          className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-body-medium-default text-[var(--content-default)]"
        >
          <span>Meeting note apps</span>
          <span className="flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)]">
            {sources.length}
            <ChevronDown
              className="h-4 w-4 transition-transform group-open:rotate-180"
              aria-hidden
            />
          </span>
        </summary>
        <div role="list" aria-label="Meeting note connections">
          {sources.map((source) => (
            <div
              key={source.id}
              role="listitem"
              className="flex items-start gap-3 border-t border-[var(--border-element)] px-4 py-3"
            >
              <IntegrationIcon
                providerKey={source.id}
                displayName={source.displayName}
                logoUrl={null}
                size={32}
              />
              <div className="min-w-0 flex-1">
                <p className="text-title-small text-[var(--content-default)]">
                  {source.displayName}
                </p>
                <p className="mt-0.5 text-body-medium-lighter text-[var(--content-tertiary)]">
                  {source.description}
                </p>
                <span
                  className="mt-1 inline-flex rounded-full bg-[var(--surface-active)] px-2.5 py-1 text-label-small-default text-[var(--content-secondary)]"
                  aria-label={`${source.displayName} status: ${source.statusLabel}`}
                >
                  {source.statusLabel}
                </span>
              </div>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
