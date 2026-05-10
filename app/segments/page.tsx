"use client";

import { SegmentsClient } from "@/components/segments/segments-client";
import { LegacySurfaceNotice } from "@/components/legacy-surface-notice";

export default function SegmentsPage() {
  return (
    <div className="space-y-6">
      <LegacySurfaceNotice title="Legacy RFM segment surface">
        RFM segment cards are retained for comparison only. Future audience work should use customer scoring and
        micro-segment definitions.
      </LegacySurfaceNotice>
      <SegmentsClient />
    </div>
  );
}
