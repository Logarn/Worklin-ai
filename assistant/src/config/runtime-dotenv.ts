import { config as dotenvConfig } from "dotenv";

import { getDotEnvPath } from "../util/platform.js";
import { isPooledWorkerRuntime } from "./env.js";

const DEPLOYMENT_ONLY_ENV_NAMES = new Set([
  "IS_CONTAINERIZED",
  "IS_PLATFORM",
  "RUNTIME_ASSISTANT_SCOPE_MODE",
  "VELLUM_WORKSPACE_DIR",
  "WORKLIN_PLATFORM_ASSISTANT_ID",
  "WORKLIN_RUNTIME_MODE",
]);

function isDeploymentOnlyRuntimeEnv(name: string): boolean {
  return (
    DEPLOYMENT_ONLY_ENV_NAMES.has(name) ||
    name.startsWith("WORKLIN_RUNTIME_WORKER_")
  );
}

/**
 * Load the local dotenv file without allowing tenant-persisted data to define
 * worker identity.
 *
 * Pooled workers skip the file completely: the volume may still contain the
 * previous tenant after a crash. Dedicated/local runtimes preserve the
 * existing dotenv behavior, except deployment-only runtime bindings must
 * always come from the process environment.
 */
export function loadRuntimeDotEnv(): void {
  if (isPooledWorkerRuntime()) return;

  const parsedEnv: Record<string, string> = {};
  dotenvConfig({
    path: getDotEnvPath(),
    processEnv: parsedEnv,
    quiet: true,
  });

  for (const [name, value] of Object.entries(parsedEnv)) {
    if (!isDeploymentOnlyRuntimeEnv(name) && process.env[name] === undefined) {
      process.env[name] = value;
    }
  }
}

export function isDeploymentOnlyRuntimeEnvForTesting(name: string): boolean {
  return isDeploymentOnlyRuntimeEnv(name);
}
