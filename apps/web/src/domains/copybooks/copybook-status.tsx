import { Tag, type TagTone } from "@vellumai/design-library/components/tag";

import type {
  CopybookCampaignStatus,
  CopybookStrategyStatus,
} from "./copybook-api";

export type DisplayStatus = CopybookCampaignStatus | CopybookStrategyStatus;

const STATUS_LABELS: Record<DisplayStatus, string> = {
  draft: "Strategy draft",
  in_review: "Strategy review",
  brief_draft: "Brief draft",
  brief_review: "Brief review",
  brief_approved: "Brief approved",
  copy_draft: "Copy draft",
  copy_review: "Copy review",
  approved: "Approved",
  ready_for_design: "Ready for design",
};

const STATUS_TONES: Record<DisplayStatus, TagTone> = {
  draft: "neutral",
  in_review: "warning",
  brief_draft: "neutral",
  brief_review: "warning",
  brief_approved: "positive",
  copy_draft: "neutral",
  copy_review: "warning",
  approved: "positive",
  ready_for_design: "positive",
};

export function formatCopybookStatus(status: DisplayStatus): string {
  return STATUS_LABELS[status];
}

export function CopybookStatus({ status }: { status: DisplayStatus }) {
  return <Tag tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Tag>;
}
