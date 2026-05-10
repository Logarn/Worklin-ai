export const LEGACY_EXECUTION_DISABLED_CODE = "LEGACY_EXTERNAL_EXECUTION_DISABLED";

export class LegacyExternalExecutionBlockedError extends Error {
  constructor(action: string) {
    super(
      `Legacy ${action} is disabled. Use the agent workflow, approval posture, and draft-only paths instead.`,
    );
    this.name = "LegacyExternalExecutionBlockedError";
  }
}

export function legacyExecutionDisabledPayload(action: string) {
  return {
    ok: false,
    code: LEGACY_EXECUTION_DISABLED_CODE,
    error: `Legacy ${action} is disabled by default.`,
    reason:
      "This route can perform live external Klaviyo actions and is intentionally gated outside the approved Tool Runtime / approval posture.",
    allowedPath:
      "Use /agent for audit, planning, QA, approvals, and draft-only Klaviyo campaign creation.",
    externalActionTaken: false,
  };
}

export function blockLegacyExternalExecution(action: string): void {
  throw new LegacyExternalExecutionBlockedError(action);
}
