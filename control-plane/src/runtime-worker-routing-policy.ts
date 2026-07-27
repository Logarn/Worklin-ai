import type { RuntimeStackRow } from "./runtime-stacks.js";
import type { RuntimeWorkerProductionCoordinatorConfig } from "./runtime-worker-production-coordinator.js";

export type RuntimeWorkerRoutingPolicy =
  | { mode: "dedicated"; stack: RuntimeStackRow }
  | { mode: "pooled" }
  | {
      mode: "unavailable";
      reason:
        | "pool_disabled"
        | "dedicated_runtime_in_transition"
        | "dedicated_runtime_suspended"
        | "dedicated_runtime_deleted";
    };

/**
 * Selects the deployment boundary without mutating either runtime system.
 *
 * Existing routable assistants stay on their dedicated runtime. Only an
 * unallocated placeholder row may fall back to the pooled worker fleet. Any
 * evidence that dedicated provisioning owns resources or an active
 * provisioning lease makes the decision fail closed, preventing two runtimes
 * from concurrently serving the same assistant.
 */
export function selectRuntimeWorkerRoutingPolicy(
  stack: RuntimeStackRow,
  coordinator: RuntimeWorkerProductionCoordinatorConfig,
  nowMs: number,
): RuntimeWorkerRoutingPolicy {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Runtime routing policy time is invalid.");
  }

  if (stack.status === "active" && stack.gateway_url) {
    return { mode: "dedicated", stack };
  }
  if (stack.status === "suspended") {
    return { mode: "unavailable", reason: "dedicated_runtime_suspended" };
  }
  if (stack.status === "deleted") {
    return { mode: "unavailable", reason: "dedicated_runtime_deleted" };
  }
  if (!coordinator.enabled) {
    return { mode: "unavailable", reason: "pool_disabled" };
  }

  const dedicatedRuntimeOwnsResources =
    stack.gateway_url !== null ||
    stack.service_ref !== null ||
    stack.workspace_volume_ref !== null ||
    stack.service_capacity_reserved !== 0 ||
    stack.provisioning_lease_token !== null ||
    stack.service_create_attempted_at !== null ||
    stack.volume_create_attempted_at !== null;

  if (
    (stack.status !== "provisioning" && stack.status !== "failed") ||
    dedicatedRuntimeOwnsResources
  ) {
    return {
      mode: "unavailable",
      reason: "dedicated_runtime_in_transition",
    };
  }

  return { mode: "pooled" };
}
