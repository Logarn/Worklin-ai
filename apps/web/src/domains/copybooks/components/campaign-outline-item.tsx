import { Mail, MessageSquareMore } from "lucide-react";

import type { CopybookCampaign } from "../copybook-api";
import { CopybookStatus } from "../copybook-status";

export function CampaignOutlineItem({ campaign }: { campaign: CopybookCampaign }) {
  const ChannelIcon = campaign.channel === "sms" ? MessageSquareMore : Mail;
  const microCampaign = microCampaignSummary(campaign);

  return (
    <li className="rounded-md border border-[var(--border-base)] bg-[var(--surface-overlay)] p-2.5">
      <div className="flex min-w-0 items-start gap-2">
        <ChannelIcon
          size={14}
          className="mt-0.5 shrink-0 text-[var(--content-secondary)]"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body-small-emphasised text-[var(--content-default)]">
            {campaign.ordinal}. {campaign.title}
          </p>
          {microCampaign ? (
            <div className="mt-1 space-y-1 text-caption-default text-[var(--content-secondary)]">
              {microCampaign.segment ? (
                <p className="line-clamp-2">
                  Segment: {microCampaign.segment}
                </p>
              ) : null}
              {microCampaign.angle ? (
                <p className="line-clamp-2">
                  Angle: {microCampaign.angle}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-x-2 gap-y-1">
                {microCampaign.eligible ? (
                  <span>{microCampaign.eligible} eligible</span>
                ) : null}
                {microCampaign.samples ? (
                  <span>{microCampaign.samples} drafts</span>
                ) : null}
              </div>
              {microCampaign.subjects.length > 0 ? (
                <p className="line-clamp-2">
                  Subjects: {microCampaign.subjects.join(" / ")}
                </p>
              ) : null}
              {microCampaign.bodyPreview ? (
                <p className="line-clamp-3">
                  Copy: {microCampaign.bodyPreview}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="mt-1.5">
            <CopybookStatus status={campaign.status} />
          </div>
        </div>
      </div>
    </li>
  );
}

function microCampaignSummary(campaign: CopybookCampaign) {
  const metadata = recordValue(campaign.metadata);
  if (
    metadata.source !== "retention_segment_run" &&
    metadata.source !== "retention_audience_review"
  ) {
    return null;
  }

  return {
    segment: stringValue(metadata.microSegmentName),
    angle:
      stringValue(metadata.campaignAngle) ||
      stringValue(recordValue(metadata.campaignConcept).angle),
    eligible: numberLabel(metadata.eligibleCount),
    samples: numberLabel(metadata.sampleCount),
    subjects: arrayValue(metadata.draftSubjects)
      .map(stringValue)
      .filter(Boolean)
      .slice(0, 2),
    bodyPreview: firstBodyPreview(metadata.representativeMessages),
  };
}

function firstBodyPreview(value: unknown): string {
  const message = arrayValue(value)
    .map(recordValue)
    .find((item) => stringValue(item.body));
  const body = stringValue(message?.body).replace(/\s+/g, " ");
  return body.length > 180 ? `${body.slice(0, 177).trim()}...` : body;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberLabel(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : null;
}
