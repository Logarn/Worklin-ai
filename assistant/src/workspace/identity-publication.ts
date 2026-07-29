import { readFileSync } from "node:fs";

import { parseIdentityFields } from "../daemon/handlers/identity.js";
import { syncIdentityNameToPlatform } from "../platform/sync-identity.js";
import { publishIdentityChanged } from "../runtime/sync/resource-sync-events.js";
import { getWorkspacePromptPath } from "../util/platform.js";
import {
  readHatchedAtSidecar,
  resolveHatchedAtReadOnly,
  writeHatchedAtSidecarOrThrow,
} from "./hatched-date.js";
import { advanceIdentityChangeEpoch } from "./identity-change-invalidation.js";
import {
  readIdentityContent,
  withIdentityWriteCoordination,
} from "./identity-file-write.js";

interface IdentityPublicationOptions<T> {
  didCommit?: (result: T) => boolean;
}

/**
 * Serialize bulk workspace replacement with ordinary identity writes, then
 * publish one authoritative identity change after a successful commit.
 */
export async function withCoordinatedIdentityPublication<T>(
  operation: () => Promise<T> | T,
  options?: IdentityPublicationOptions<T>,
): Promise<T> {
  return withIdentityWriteCoordination(async () => {
    const identityPath = getWorkspacePromptPath("IDENTITY.md");
    const previousHatchedAt = resolveHatchedAtReadOnly(identityPath);
    const result = await operation();

    if (options?.didCommit && !options.didCommit(result)) {
      return result;
    }

    // This validates that an import did not install a canonical symlink or a
    // hard-linked identity that future atomic writes would have to split.
    readIdentityContent(identityPath);

    if (!readHatchedAtSidecar()) {
      writeHatchedAtSidecarOrThrow(previousHatchedAt);
    }

    advanceIdentityChangeEpoch();

    let content = "";
    try {
      content = readFileSync(identityPath, "utf-8");
    } catch {
      // A successful import may intentionally omit IDENTITY.md.
    }
    const fields = parseIdentityFields(content);
    publishIdentityChanged(fields);
    if (fields.name) {
      syncIdentityNameToPlatform(fields.name);
    }

    return result;
  });
}
