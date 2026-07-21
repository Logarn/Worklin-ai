import type { Database } from "bun:sqlite";

import {
  pooledRuntimeWorkerCatalogConfigFromServerEnv,
  registerPooledRuntimeWorkerCatalog,
  type PooledRuntimeWorkerCatalogConfig,
  type PooledRuntimeWorkerCatalogRegistration,
} from "./runtime-worker-catalog.js";
import {
  probePooledRuntimeWorkerCatalog,
  runtimeWorkerHealthProbeConfigFromServerEnv,
  type RuntimeWorkerHealthProbeConfig,
  type RuntimeWorkerHealthProbeDependencies,
  type RuntimeWorkerHealthProbeResult,
} from "./runtime-worker-health-probe.js";
import {
  runtimeWorkerProductionCoordinatorConfigFromEnv,
  type RuntimeWorkerProductionCoordinatorConfig,
} from "./runtime-worker-production-coordinator.js";
import { runtimeWorkerProductionTransportConfigFromEnv } from "./runtime-worker-production-transport.js";
import { requirePooledModelKeyVaultForPoolStartup } from "./pooled-model-key-vault.js";
import { ensureRuntimeStackSchema } from "./runtime-stacks.js";
import {
  runtimeWorkerCoordinatorOwnershipConfigFromEnv,
  type RuntimeWorkerCoordinatorOwnershipConfig,
  type RuntimeWorkerCoordinatorOwnershipLiveness,
} from "./runtime-worker-coordinator-ownership.js";

type EnvLike = Record<string, string | undefined>;

const CATALOG_ENABLE_ENV = "WORKLIN_RUNTIME_WORKER_CATALOG_ENABLED";
const POOL_ENABLE_ENV = "WORKLIN_RUNTIME_WORKER_POOL_ENABLED";
const TRANSPORT_ENABLE_ENV =
  "WORKLIN_RUNTIME_WORKER_PRODUCTION_TRANSPORT_ENABLED";
const HEALTH_PROBE_ENABLE_ENV = "WORKLIN_RUNTIME_WORKER_HEALTH_PROBE_ENABLED";
const CANDIDATE_STACK_IDS_ENV = "WORKLIN_RUNTIME_WORKER_POOL_STACK_IDS";

export interface RuntimeWorkerStartupActivation {
  status: "disabled" | "active";
  catalogWorkerCount: number;
  registeredWorkerCount: number;
  healthyWorkerCount: number;
  failedWorkerCount: number;
  driftedWorkerCount: number;
  maxConcurrentLeases: number;
}

export type RuntimeWorkerStartupHealthProbe = (
  db: Database,
  config: RuntimeWorkerHealthProbeConfig,
  catalog: PooledRuntimeWorkerCatalogConfig,
  dependencies?: RuntimeWorkerHealthProbeDependencies,
) => Promise<RuntimeWorkerHealthProbeResult>;

export interface RuntimeWorkerStartupGateDependencies {
  nowIso?: () => string;
  probe?: RuntimeWorkerStartupHealthProbe;
  probeDependencies?: RuntimeWorkerHealthProbeDependencies;
  coordinatorOwnership?: RuntimeWorkerStartupCoordinatorOwnership;
}

export type RuntimeWorkerStartupCoordinatorOwnership =
  RuntimeWorkerCoordinatorOwnershipLiveness;

interface EnabledStartupConfig {
  catalog: PooledRuntimeWorkerCatalogConfig & { enabled: true };
  coordinator: RuntimeWorkerProductionCoordinatorConfig & { enabled: true };
  ownership: RuntimeWorkerCoordinatorOwnershipConfig & { enabled: true };
}

function strictBooleanEnv(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (value !== value.trim()) {
    throw new Error(`${name} must not contain surrounding whitespace.`);
  }
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean.`);
}

function disabledActivation(): RuntimeWorkerStartupActivation {
  return Object.freeze({
    status: "disabled",
    catalogWorkerCount: 0,
    registeredWorkerCount: 0,
    healthyWorkerCount: 0,
    failedWorkerCount: 0,
    driftedWorkerCount: 0,
    maxConcurrentLeases: 0,
  });
}

function exactOrderedIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function assertUniqueCandidateStackIds(rawEnv: EnvLike): void {
  const raw = rawEnv[CANDIDATE_STACK_IDS_ENV] ?? "";
  const segments = raw.split(",");
  const candidateStackIds = segments.map((value) => value.trim());
  if (
    candidateStackIds.length === 0 ||
    candidateStackIds.some((value) => value.length === 0)
  ) {
    throw new Error("Pooled runtime candidate worker IDs are invalid.");
  }
  if (new Set(candidateStackIds).size !== candidateStackIds.length) {
    throw new Error("Pooled runtime candidate worker IDs must be unique.");
  }
}

function enabledStartupConfigFromEnv(
  rawEnv: EnvLike,
): EnabledStartupConfig | null {
  const componentFlags = [
    strictBooleanEnv(CATALOG_ENABLE_ENV, rawEnv[CATALOG_ENABLE_ENV]),
    strictBooleanEnv(POOL_ENABLE_ENV, rawEnv[POOL_ENABLE_ENV]),
    strictBooleanEnv(TRANSPORT_ENABLE_ENV, rawEnv[TRANSPORT_ENABLE_ENV]),
    strictBooleanEnv(HEALTH_PROBE_ENABLE_ENV, rawEnv[HEALTH_PROBE_ENABLE_ENV]),
  ];
  const anyEnabled = componentFlags.some(Boolean);
  if (!anyEnabled) {
    pooledRuntimeWorkerCatalogConfigFromServerEnv(rawEnv);
    runtimeWorkerProductionCoordinatorConfigFromEnv(rawEnv);
    runtimeWorkerHealthProbeConfigFromServerEnv(rawEnv);
    runtimeWorkerProductionTransportConfigFromEnv(rawEnv);
    return null;
  }
  if (!componentFlags.every(Boolean)) {
    throw new Error(
      "Pooled runtime startup requires catalog, pool, production transport, and health probe gates.",
    );
  }

  const catalog = pooledRuntimeWorkerCatalogConfigFromServerEnv(rawEnv);
  const coordinator = runtimeWorkerProductionCoordinatorConfigFromEnv(rawEnv);
  const healthProbe = runtimeWorkerHealthProbeConfigFromServerEnv(rawEnv);
  const transport = runtimeWorkerProductionTransportConfigFromEnv(rawEnv);
  const ownership = runtimeWorkerCoordinatorOwnershipConfigFromEnv(
    rawEnv,
    true,
  );
  if (
    !catalog.enabled ||
    !coordinator.enabled ||
    !healthProbe.enabled ||
    transport === null ||
    !ownership.enabled
  ) {
    throw new Error("Pooled runtime startup configuration is incomplete.");
  }

  assertUniqueCandidateStackIds(rawEnv);
  const catalogWorkerIds = catalog.workers.map(({ workerId }) => workerId);
  if (
    new Set(catalogWorkerIds).size !== catalogWorkerIds.length ||
    !catalog.workers.every(({ capacity }) => capacity.maxConcurrentLeases === 1)
  ) {
    throw new Error("Pooled runtime catalog capacity is invalid.");
  }
  if (!exactOrderedIds(coordinator.pool.candidateStackIds, catalogWorkerIds)) {
    throw new Error(
      "Pooled runtime candidate workers must exactly match catalog order.",
    );
  }
  if (
    coordinator.pool.maxConcurrentLeases < 1 ||
    coordinator.pool.maxConcurrentLeases > catalog.workers.length
  ) {
    throw new Error(
      "Pooled runtime global concurrency exceeds declared worker capacity.",
    );
  }

  return {
    catalog: catalog as PooledRuntimeWorkerCatalogConfig & { enabled: true },
    coordinator: coordinator as RuntimeWorkerProductionCoordinatorConfig & {
      enabled: true;
    },
    ownership: ownership as RuntimeWorkerCoordinatorOwnershipConfig & {
      enabled: true;
    },
  };
}

function requireLiveCoordinatorOwnership(
  ownership: RuntimeWorkerStartupCoordinatorOwnership | undefined,
  config: EnabledStartupConfig,
): void {
  if (
    !ownership ||
    ownership.binding.deploymentId !== config.ownership.deploymentId ||
    ownership.binding.replicaId !== config.ownership.replicaId ||
    !ownership.isLive()
  ) {
    throw new Error(
      "Pooled runtime startup requires live singleton coordinator ownership.",
    );
  }
}

function assertRegistration(
  registration: PooledRuntimeWorkerCatalogRegistration,
  config: EnabledStartupConfig,
): void {
  const catalogWorkerIds = config.catalog.workers.map(
    ({ workerId }) => workerId,
  );
  if (
    registration.status !== "registered" ||
    !exactOrderedIds(registration.workerIds, catalogWorkerIds) ||
    registration.totalMaxConcurrentLeases !== config.catalog.workers.length
  ) {
    throw new Error("Pooled runtime catalog registration is inconsistent.");
  }
}

function assertGreenHealth(
  health: RuntimeWorkerHealthProbeResult,
  catalogWorkerCount: number,
): void {
  const failedWorkerCount =
    health.httpFailureCount + health.timeoutCount + health.fetchFailureCount;
  if (
    health.status !== "completed" ||
    health.registeredWorkerCount !== catalogWorkerCount ||
    health.probedWorkerCount !== catalogWorkerCount ||
    health.healthyWorkerCount !== catalogWorkerCount ||
    failedWorkerCount !== 0 ||
    health.updatedWorkerCount !== catalogWorkerCount ||
    health.driftedWorkerCount !== 0
  ) {
    throw new Error("Pooled runtime startup health gate is not green.");
  }
}

export async function activatePooledRuntimeWorkersAtStartup(
  db: Database,
  rawEnv: EnvLike,
  dependencies: RuntimeWorkerStartupGateDependencies = {},
): Promise<RuntimeWorkerStartupActivation> {
  const config = enabledStartupConfigFromEnv(rawEnv);
  if (!config) return disabledActivation();

  requirePooledModelKeyVaultForPoolStartup(db, rawEnv);
  requireLiveCoordinatorOwnership(dependencies.coordinatorOwnership, config);
  ensureRuntimeStackSchema(db);
  const registration = registerPooledRuntimeWorkerCatalog(
    db,
    config.catalog,
    dependencies.nowIso ?? (() => new Date().toISOString()),
  );
  assertRegistration(registration, config);

  const probe = dependencies.probe ?? probePooledRuntimeWorkerCatalog;
  const health = await probe(
    db,
    runtimeWorkerHealthProbeConfigFromServerEnv(rawEnv),
    config.catalog,
    dependencies.probeDependencies,
  );
  assertGreenHealth(health, config.catalog.workers.length);
  requireLiveCoordinatorOwnership(dependencies.coordinatorOwnership, config);

  return Object.freeze({
    status: "active",
    catalogWorkerCount: config.catalog.workers.length,
    registeredWorkerCount: registration.workerIds.length,
    healthyWorkerCount: health.healthyWorkerCount,
    failedWorkerCount: 0,
    driftedWorkerCount: 0,
    maxConcurrentLeases: config.coordinator.pool.maxConcurrentLeases,
  });
}
