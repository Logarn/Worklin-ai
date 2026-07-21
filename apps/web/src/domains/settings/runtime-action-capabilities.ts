import type { RuntimeActionCapability } from "@/generated/api/types.gen";

type RuntimeAction = RuntimeActionCapability["capability"];

const UNKNOWN_CAPABILITY_DETAILS: Record<RuntimeAction, string> = {
  restart:
    "Restart is unavailable while Worklin verifies this assistant's runtime capabilities.",
  terminal:
    "Terminal is unavailable while Worklin verifies this assistant's runtime capabilities.",
  doctor:
    "Assistant Doctor is unavailable while Worklin verifies this assistant's runtime capabilities.",
  update_window:
    "Update windows are unavailable while Worklin verifies this assistant's runtime capabilities.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function resolveRuntimeActionCapability(
  capabilities: unknown,
  action: RuntimeAction,
  requireExplicitCapability: boolean,
): RuntimeActionCapability | undefined {
  const candidate = isRecord(capabilities) ? capabilities[action] : undefined;
  if (isRecord(candidate)) {
    const supported = candidate.supported;
    const expectedCode = supported
      ? "supported"
      : "runtime_capability_unavailable";
    if (
      candidate.capability === action &&
      typeof supported === "boolean" &&
      candidate.code === expectedCode &&
      typeof candidate.detail === "string" &&
      candidate.detail.trim().length > 0
    ) {
      return {
        capability: action,
        supported,
        code: expectedCode,
        detail: candidate.detail,
      };
    }
  }

  if (!requireExplicitCapability) return undefined;
  return {
    capability: action,
    supported: false,
    code: "runtime_capability_unavailable",
    detail: UNKNOWN_CAPABILITY_DETAILS[action],
  };
}
