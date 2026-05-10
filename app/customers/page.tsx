import { CustomersClient } from "@/components/customers/customers-client";
import { LegacySurfaceNotice } from "@/components/legacy-surface-notice";

export default function CustomersPage() {
  return (
    <div className="space-y-6">
      <LegacySurfaceNotice title="Legacy customer directory">
        This raw customer browser is internal while Worklin moves customer work to identity, feature, scoring, and
        micro-segment agent tools.
      </LegacySurfaceNotice>
      <CustomersClient />
    </div>
  );
}
