import { existsSync, readFileSync } from "node:fs";

import { getMetadataPath } from "./credential-reader.js";
import {
  POOLED_SHARED_STATE_ERROR_CODE,
  isPooledGatewayRuntime,
} from "./pooled-runtime-shared-state.js";

const MALFORMED_CREDENTIAL_METADATA = "<malformed>";

export function shouldStartSharedGatewayBackgroundServices(): boolean {
  return !isPooledGatewayRuntime();
}

export function findForbiddenPooledCredentialServices(
  metadata: unknown,
): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return [MALFORMED_CREDENTIAL_METADATA];
  }
  const credentials = (metadata as { credentials?: unknown }).credentials;
  if (credentials === undefined) return [];
  if (!Array.isArray(credentials)) return [MALFORMED_CREDENTIAL_METADATA];

  const services = new Set<string>();
  for (const entry of credentials) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      services.add(MALFORMED_CREDENTIAL_METADATA);
      continue;
    }
    const service = (entry as { service?: unknown }).service;
    if (typeof service === "string" && service.trim()) {
      services.add(service.trim());
    } else {
      services.add(MALFORMED_CREDENTIAL_METADATA);
    }
  }
  return [...services].sort();
}

/**
 * Pooled workers use the control-plane model-key vault and must never inherit
 * any credential metadata from a prior assistant. Pooled model keys arrive in
 * the request-bound control-plane vault, never in this gateway store. Treat
 * unknown, custom, partial, and malformed entries as unsafe: a later CES/file
 * write must not turn a dormant pooled process into a process-global listener.
 */
export function assertPooledGatewayCredentialBoundary(
  metadataPath = getMetadataPath(),
): void {
  if (!isPooledGatewayRuntime() || !existsSync(metadataPath)) return;

  let metadata: unknown;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {
    throw new Error(
      `${POOLED_SHARED_STATE_ERROR_CODE}: pooled gateway credential metadata is unreadable`,
    );
  }

  const forbidden = findForbiddenPooledCredentialServices(metadata);
  if (forbidden.length === 0) return;
  throw new Error(
    `${POOLED_SHARED_STATE_ERROR_CODE}: pooled gateway contains credential metadata for ${forbidden.join(", ")}`,
  );
}
