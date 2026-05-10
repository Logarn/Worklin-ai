"use client";

import { DashboardClient } from "@/components/dashboard/dashboard-client";
import { LegacySurfaceNotice } from "@/components/legacy-surface-notice";

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <LegacySurfaceNotice title="Legacy analytics surface">
        This dashboard is retained for source diagnostics and historical analytics. The primary Worklin path is
        agent-led audit and canvas review.
      </LegacySurfaceNotice>
      <DashboardClient />
    </div>
  );
}
