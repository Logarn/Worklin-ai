import { PlanBriefClient } from "@/components/planner/plan-brief-client";
import { LegacySurfaceNotice } from "@/components/legacy-surface-notice";

export default function PlannerPage() {
  return (
    <div className="space-y-6">
      <LegacySurfaceNotice title="Secondary planner workbench">
        Planner, brief, and QA code is still useful. This page remains as a secondary workbench while the primary
        experience moves into the agent canvas.
      </LegacySurfaceNotice>
      <PlanBriefClient />
    </div>
  );
}
