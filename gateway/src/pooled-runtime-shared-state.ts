export const POOLED_SHARED_STATE_ERROR_CODE =
  "POOLED_SHARED_STATE_DISABLED" as const;

export const POOLED_STRICT_AUTO_APPROVE_THRESHOLDS = Object.freeze({
  interactive: "none" as const,
  autonomous: "none" as const,
  headless: "none" as const,
});

export const POOLED_SAFE_PRIVACY_CONFIG = Object.freeze({
  collectUsageData: false,
  sendDiagnostics: false,
  llmRequestLogRetentionMs: 0,
});

export function isPooledGatewayRuntime(): boolean {
  const runtimeMode = process.env.WORKLIN_RUNTIME_MODE?.trim().toLowerCase();
  return (
    runtimeMode === "pooled" ||
    runtimeMode === "pooled_worker" ||
    Boolean(process.env.WORKLIN_RUNTIME_WORKER_STACK_ID?.trim())
  );
}

export function pooledSharedStateUnavailableResponse(
  resource: string,
): Response {
  return Response.json(
    {
      error: `${resource} requires a dedicated runtime`,
      code: POOLED_SHARED_STATE_ERROR_CODE,
    },
    { status: 503 },
  );
}

export function assertPooledSharedStateUnavailable(resource: string): void {
  if (!isPooledGatewayRuntime()) return;
  throw new Error(
    `${POOLED_SHARED_STATE_ERROR_CODE}: ${resource} requires a dedicated runtime`,
  );
}

export function rejectPooledSharedStateAccess(
  resource: string,
): Response | null {
  return isPooledGatewayRuntime()
    ? pooledSharedStateUnavailableResponse(resource)
    : null;
}
