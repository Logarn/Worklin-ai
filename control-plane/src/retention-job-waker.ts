import type { RetentionServiceConfig } from "./retention-service-config.js";
import {
  proxyAuthenticatedRetentionRequest,
  type RetentionServiceFetch,
} from "./retention-service-proxy.js";

const SYSTEM_USER_ID = "worklin-retention-job-waker";
const MAX_CONCURRENT_WAKES = 8;

export interface RetentionTenantWakeTarget {
  organizationId: string;
  assistantId: string;
}

export async function wakeRetentionTenantJobs(
  config: RetentionServiceConfig,
  targets: readonly RetentionTenantWakeTarget[],
  dependencies: { fetch?: RetentionServiceFetch } = {},
): Promise<{ attempted: number; accepted: number; failed: number }> {
  if (!config.enabled) {
    return { attempted: 0, accepted: 0, failed: 0 };
  }
  let accepted = 0;
  let failed = 0;
  for (let offset = 0; offset < targets.length; offset += MAX_CONCURRENT_WAKES) {
    const batch = targets.slice(offset, offset + MAX_CONCURRENT_WAKES);
    const results = await Promise.all(
      batch.map(async (target) => {
        try {
          const response = await proxyAuthenticatedRetentionRequest(
            config,
            new Request(
              "http://control-plane.internal/v1/retention/jobs/wake",
              { method: "POST" },
            ),
            {
              organizationId: target.organizationId,
              userId: SYSTEM_USER_ID,
              assistantId: target.assistantId,
              roles: ["retention_marketer"],
            },
            dependencies,
          );
          await response.arrayBuffer().catch(() => undefined);
          return response.status === 202;
        } catch {
          return false;
        }
      }),
    );
    accepted += results.filter(Boolean).length;
    failed += results.filter((result) => !result).length;
  }
  return { attempted: targets.length, accepted, failed };
}
