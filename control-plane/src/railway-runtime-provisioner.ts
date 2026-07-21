import { createHash, randomBytes } from "node:crypto";

import type { AssistantRuntimeRow, RuntimeStackRow } from "./runtime-stacks.js";

const DEFAULT_API_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const DEFAULT_REPOSITORY = "Logarn/Worklin-ai";
const SUCCESSFUL_DEPLOYMENT_STATUSES = new Set(["SUCCESS"]);
const FAILED_DEPLOYMENT_STATUSES = new Set([
  "CANCELLED",
  "CRASHED",
  "FAILED",
  "REMOVED",
]);

type EnvLike = Record<string, string | undefined>;
type FetchLike = typeof fetch;
type Sleep = (delayMs: number) => Promise<void>;

export interface RailwayProvisionerConfig {
  enabled: boolean;
  apiEndpoint: string;
  projectToken: string;
  projectId: string;
  environmentId: string;
  repository: string;
  branch: string;
  region: string | null;
  mountPath: string;
  runtimePort: number;
  maxRuntimeServices: number;
  /** Safety quota for one workspace; defaults to one when omitted. */
  maxRuntimeServicesPerWorkspace?: number;
  maxConcurrentProvisioning: number;
  requestTimeoutMs: number;
  serviceReconcileTimeoutMs: number;
  provisioningLeaseTtlMs: number;
  pollIntervalMs: number;
  deployTimeoutMs: number;
  healthTimeoutMs: number;
  /** Railway injects this into the control-plane service at runtime. */
  controlPlaneServiceId?: string | null;
}

export interface RailwayProvisioningPersistence {
  renewLease(): void;
  recordServiceCreateAttempt(attemptedAt: number): void;
  recordVolumeCreateAttempt(attemptedAt: number): void;
  recordService(serviceId: string): void;
  recordVolume(volumeId: string): void;
  markActive(gatewayUrl: string, healthStatus: string): void;
}

export interface ProvisionRailwayRuntimeOptions {
  assistant: AssistantRuntimeRow;
  stack: RuntimeStackRow;
  runtimeActorSigningKey: string;
  allowServiceCreation: boolean;
  config: RailwayProvisionerConfig;
  persistence: RailwayProvisioningPersistence;
  fetchImpl?: FetchLike;
  sleep?: Sleep;
  now?: () => number;
}

export interface RailwayRuntimeRetirementPersistence {
  renewLease(): void;
  confirmVolumeCleanup(): void;
  confirmServiceCleanup(): void;
}

export interface RetireRailwayRuntimeOptions {
  serviceId: string | null;
  volumeId: string | null;
  serviceCleanupConfirmed: boolean;
  volumeCleanupConfirmed: boolean;
  config: RailwayProvisionerConfig;
  persistence: RailwayRuntimeRetirementPersistence;
  fetchImpl?: FetchLike;
}

export type RailwayRuntimeRetirementErrorCode =
  | "configuration"
  | "protected_service"
  | "cleanup_unconfirmed";

export class RailwayRuntimeRetirementError extends Error {
  constructor(
    readonly code: RailwayRuntimeRetirementErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RailwayRuntimeRetirementError";
  }
}

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface RailwayResourceConnection {
  edges: Array<{ node: { id: string } }>;
  pageInfo?: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
}

interface RailwayProjectResourcesResponse {
  project: {
    services: RailwayResourceConnection;
    volumes: RailwayResourceConnection;
  } | null;
}

function boolEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function positiveIntegerEnv(
  value: string | undefined,
  fallback: number,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function railwayProvisionerConfigFromEnv(
  rawEnv: EnvLike,
): RailwayProvisionerConfig {
  return {
    enabled: boolEnv(rawEnv.WORKLIN_RAILWAY_PROVISIONING_ENABLED),
    apiEndpoint: trimTrailingSlash(
      rawEnv.WORKLIN_RAILWAY_API_ENDPOINT?.trim() || DEFAULT_API_ENDPOINT,
    ),
    projectToken: rawEnv.WORKLIN_RAILWAY_PROJECT_TOKEN?.trim() || "",
    projectId: rawEnv.WORKLIN_RAILWAY_PROJECT_ID?.trim() || "",
    environmentId: rawEnv.WORKLIN_RAILWAY_ENVIRONMENT_ID?.trim() || "",
    repository:
      rawEnv.WORKLIN_RAILWAY_RUNTIME_REPOSITORY?.trim() || DEFAULT_REPOSITORY,
    branch: rawEnv.WORKLIN_RAILWAY_RUNTIME_BRANCH?.trim() || "main",
    region: rawEnv.WORKLIN_RAILWAY_RUNTIME_REGION?.trim() || null,
    mountPath: rawEnv.WORKLIN_RAILWAY_RUNTIME_MOUNT_PATH?.trim() || "/data",
    runtimePort: positiveIntegerEnv(rawEnv.WORKLIN_RAILWAY_RUNTIME_PORT, 8080),
    maxRuntimeServices: positiveIntegerEnv(
      rawEnv.WORKLIN_RAILWAY_MAX_RUNTIME_SERVICES,
      0,
    ),
    maxRuntimeServicesPerWorkspace: positiveIntegerEnv(
      rawEnv.WORKLIN_RAILWAY_MAX_RUNTIME_SERVICES_PER_WORKSPACE,
      1,
    ),
    maxConcurrentProvisioning: positiveIntegerEnv(
      rawEnv.WORKLIN_RAILWAY_PROVISIONING_CONCURRENCY,
      2,
    ),
    requestTimeoutMs: positiveIntegerEnv(
      rawEnv.WORKLIN_RAILWAY_REQUEST_TIMEOUT_MS,
      30_000,
    ),
    serviceReconcileTimeoutMs: positiveIntegerEnv(
      rawEnv.WORKLIN_RAILWAY_SERVICE_RECONCILE_TIMEOUT_MS,
      30_000,
    ),
    provisioningLeaseTtlMs: positiveIntegerEnv(
      rawEnv.WORKLIN_RAILWAY_PROVISIONING_LEASE_TTL_MS,
      2 * 60_000,
    ),
    pollIntervalMs: positiveIntegerEnv(
      rawEnv.WORKLIN_RAILWAY_POLL_INTERVAL_MS,
      5_000,
    ),
    deployTimeoutMs: positiveIntegerEnv(
      rawEnv.WORKLIN_RAILWAY_DEPLOY_TIMEOUT_MS,
      15 * 60_000,
    ),
    healthTimeoutMs: positiveIntegerEnv(
      rawEnv.WORKLIN_RAILWAY_HEALTH_TIMEOUT_MS,
      5 * 60_000,
    ),
    controlPlaneServiceId:
      rawEnv.WORKLIN_RAILWAY_CONTROL_PLANE_SERVICE_ID?.trim() ||
      rawEnv.RAILWAY_SERVICE_ID?.trim() ||
      null,
  };
}

export function railwayProvisionerConfigurationError(
  config: RailwayProvisionerConfig,
): string | null {
  if (!config.enabled) return "Railway runtime provisioning is disabled.";
  if (!config.projectToken) {
    return "WORKLIN_RAILWAY_PROJECT_TOKEN is required.";
  }
  if (!config.projectId) return "WORKLIN_RAILWAY_PROJECT_ID is required.";
  if (!config.environmentId) {
    return "WORKLIN_RAILWAY_ENVIRONMENT_ID is required.";
  }
  if (config.maxRuntimeServices < 1) {
    return "WORKLIN_RAILWAY_MAX_RUNTIME_SERVICES must be explicitly set above zero.";
  }
  if (config.provisioningLeaseTtlMs <= config.requestTimeoutMs) {
    return "WORKLIN_RAILWAY_PROVISIONING_LEASE_TTL_MS must exceed WORKLIN_RAILWAY_REQUEST_TIMEOUT_MS.";
  }
  return null;
}

export function railwayRuntimeCapacityError(
  existingServiceRef: string | null,
  allocatedRuntimeServices: number,
  maxRuntimeServices: number,
): string | null {
  if (existingServiceRef) return null;
  if (allocatedRuntimeServices < maxRuntimeServices) return null;
  return `Railway runtime service limit (${maxRuntimeServices}) has been reached.`;
}

export function railwayRuntimeWorkspaceCapacityError(
  existingServiceRef: string | null,
  allocatedRuntimeServices: number,
  maxRuntimeServices: number,
): string | null {
  if (existingServiceRef) return null;
  if (allocatedRuntimeServices < maxRuntimeServices) return null;
  return `Railway runtime workspace quota (${maxRuntimeServices}) has been reached.`;
}

export function railwayRuntimeServiceName(assistantId: string): string {
  const legacyPrefix = "worklin-runtime-";
  const maxLegacySuffixLength = 32 - legacyPrefix.length;
  const suffix = assistantId
    .toLowerCase()
    .replace(/^worklin-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const normalized = suffix || "assistant";
  if (normalized.length <= maxLegacySuffixLength) {
    return `${legacyPrefix}${normalized}`;
  }

  const prefix = "worklin-rt-";
  const hash = createHash("sha256")
    .update(assistantId)
    .digest("hex")
    .slice(0, 12);
  const readableLength = 32 - prefix.length - hash.length - 1;
  return `${prefix}${normalized.slice(0, readableLength)}-${hash}`;
}

interface ScheduledTask {
  key: string;
  task: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class BoundedKeyedTaskScheduler {
  private activeCount = 0;
  private readonly queued: ScheduledTask[] = [];
  private readonly completions = new Map<string, Promise<void>>();

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("Provisioning concurrency must be a positive integer.");
    }
  }

  has(key: string): boolean {
    return this.completions.has(key);
  }

  schedule(key: string, task: () => Promise<void>): Promise<void> {
    const existing = this.completions.get(key);
    if (existing) return existing;

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.completions.set(key, completion);
    this.queued.push({ key, task, resolve, reject });
    this.drain();
    return completion;
  }

  private drain(): void {
    while (this.activeCount < this.concurrency) {
      const scheduled = this.queued.shift();
      if (!scheduled) return;
      this.activeCount += 1;
      void Promise.resolve()
        .then(scheduled.task)
        .then(scheduled.resolve, scheduled.reject)
        .finally(() => {
          this.activeCount -= 1;
          this.completions.delete(scheduled.key);
          this.drain();
        });
    }
  }
}

class RailwayGraphqlClient {
  constructor(
    private readonly config: RailwayProvisionerConfig,
    private readonly fetchImpl: FetchLike,
    private readonly beforeRequest: () => void,
  ) {}

  async request<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    this.beforeRequest();
    const response = await this.fetchImpl(this.config.apiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Project-Access-Token": this.config.projectToken,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    const payload = (await response.json()) as GraphqlEnvelope<T>;
    if (!response.ok || payload.errors?.length || !payload.data) {
      const detail = payload.errors
        ?.map((error) => error.message || "Unknown Railway API error")
        .join("; ");
      throw new Error(
        `Railway API request failed (${response.status}): ${detail || response.statusText}`,
      );
    }
    return payload.data;
  }

  async createService(name: string): Promise<string> {
    const data = await this.request<{
      serviceCreate: { id: string };
    }>(
      `mutation serviceCreate($input: ServiceCreateInput!) {
        serviceCreate(input: $input) { id }
      }`,
      {
        input: {
          projectId: this.config.projectId,
          name,
          source: { repo: this.config.repository },
          branch: this.config.branch,
        },
      },
    );
    return data.serviceCreate.id;
  }

  async findServiceByName(name: string): Promise<string | null> {
    const data = await this.request<{
      project: {
        services: {
          edges: Array<{ node: { id: string; name: string } }>;
        };
      } | null;
    }>(
      `query runtimeProjectServices($projectId: String!) {
        project(id: $projectId) {
          services(first: 1000) {
            edges { node { id name } }
          }
        }
      }`,
      { projectId: this.config.projectId },
    );
    const matches =
      data.project?.services.edges
        .map((edge) => edge.node)
        .filter((service) => service.name === name) ?? [];
    if (matches.length > 1) {
      throw new Error(`Multiple Railway services are named ${name}.`);
    }
    return matches[0]?.id ?? null;
  }

  async createVolume(serviceId: string): Promise<string> {
    const input: Record<string, unknown> = {
      projectId: this.config.projectId,
      environmentId: this.config.environmentId,
      serviceId,
      mountPath: this.config.mountPath,
    };
    if (this.config.region) input.region = this.config.region;
    const data = await this.request<{ volumeCreate: { id: string } }>(
      `mutation volumeCreate($input: VolumeCreateInput!) {
        volumeCreate(input: $input) { id }
      }`,
      { input },
    );
    return data.volumeCreate.id;
  }

  async findVolumeForService(serviceId: string): Promise<string | null> {
    const data = await this.request<{
      environment: { config?: unknown } | null;
    }>(
      `query runtimeEnvironmentConfig($environmentId: String!) {
        environment(id: $environmentId) { config }
      }`,
      { environmentId: this.config.environmentId },
    );
    const config =
      data.environment?.config &&
      typeof data.environment.config === "object" &&
      !Array.isArray(data.environment.config)
        ? (data.environment.config as Record<string, unknown>)
        : null;
    const services =
      config?.services &&
      typeof config.services === "object" &&
      !Array.isArray(config.services)
        ? (config.services as Record<string, unknown>)
        : null;
    const service =
      services?.[serviceId] &&
      typeof services[serviceId] === "object" &&
      !Array.isArray(services[serviceId])
        ? (services[serviceId] as Record<string, unknown>)
        : null;
    const volumeMounts =
      service?.volumeMounts &&
      typeof service.volumeMounts === "object" &&
      !Array.isArray(service.volumeMounts)
        ? (service.volumeMounts as Record<string, unknown>)
        : null;
    const volumeIds = volumeMounts ? Object.keys(volumeMounts) : [];
    if (volumeIds.length > 1) {
      throw new Error(
        `Railway service ${serviceId} has multiple mounted volumes.`,
      );
    }
    return volumeIds[0] ?? null;
  }

  async setVariables(
    serviceId: string,
    variables: Record<string, string>,
  ): Promise<void> {
    await this.request<{ variableCollectionUpsert: boolean }>(
      `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
        variableCollectionUpsert(input: $input)
      }`,
      {
        input: {
          projectId: this.config.projectId,
          environmentId: this.config.environmentId,
          serviceId,
          variables,
          skipDeploys: true,
        },
      },
    );
  }

  async deploy(serviceId: string): Promise<string> {
    const data = await this.request<{ serviceInstanceDeployV2: string }>(
      `mutation serviceInstanceDeployV2($environmentId: String!, $serviceId: String!) {
        serviceInstanceDeployV2(
          environmentId: $environmentId
          serviceId: $serviceId
        )
      }`,
      {
        environmentId: this.config.environmentId,
        serviceId,
      },
    );
    return data.serviceInstanceDeployV2;
  }

  async deploymentStatus(deploymentId: string): Promise<string> {
    const data = await this.request<{
      deployment: { status: string } | null;
    }>(
      `query deployment($id: String!) {
        deployment(id: $id) { status }
      }`,
      { id: deploymentId },
    );
    if (!data.deployment) throw new Error("Railway deployment was not found.");
    return data.deployment.status.toUpperCase();
  }

  async projectResourceIds(): Promise<{
    serviceIds: Set<string>;
    volumeIds: Set<string>;
  }> {
    const serviceIds = new Set<string>();
    const volumeIds = new Set<string>();
    let servicesAfter: string | null = null;
    let volumesAfter: string | null = null;
    let servicesComplete = false;
    let volumesComplete = false;

    for (let page = 0; page < 100; page += 1) {
      const data: RailwayProjectResourcesResponse =
        await this.request<RailwayProjectResourcesResponse>(
          `query runtimeRetirementResources(
            $projectId: String!
            $servicesAfter: String
            $volumesAfter: String
          ) {
            project(id: $projectId) {
              services(first: 100, after: $servicesAfter) {
                edges { node { id } }
                pageInfo { hasNextPage endCursor }
              }
              volumes(first: 100, after: $volumesAfter) {
                edges { node { id } }
                pageInfo { hasNextPage endCursor }
              }
            }
          }`,
          { projectId: this.config.projectId, servicesAfter, volumesAfter },
        );
      if (!data.project) {
        throw new Error("Configured Railway project was not found.");
      }
      for (const edge of data.project.services.edges) {
        serviceIds.add(edge.node.id);
      }
      for (const edge of data.project.volumes.edges) {
        volumeIds.add(edge.node.id);
      }

      const servicesPage: RailwayResourceConnection["pageInfo"] =
        data.project.services.pageInfo;
      const volumesPage: RailwayResourceConnection["pageInfo"] =
        data.project.volumes.pageInfo;
      servicesComplete = servicesPage?.hasNextPage !== true;
      volumesComplete = volumesPage?.hasNextPage !== true;
      if (servicesComplete && volumesComplete) {
        return { serviceIds, volumeIds };
      }
      if (!servicesComplete) {
        if (!servicesPage?.endCursor || servicesPage.endCursor === servicesAfter) {
          throw new Error("Railway service pagination did not advance.");
        }
        servicesAfter = servicesPage.endCursor;
      }
      if (!volumesComplete) {
        if (!volumesPage?.endCursor || volumesPage.endCursor === volumesAfter) {
          throw new Error("Railway volume pagination did not advance.");
        }
        volumesAfter = volumesPage.endCursor;
      }
    }
    throw new Error("Railway resource pagination exceeded the safe limit.");
  }

  async deleteVolume(volumeId: string): Promise<void> {
    const data = await this.request<{ volumeDelete: boolean }>(
      `mutation volumeDelete($volumeId: String!) {
        volumeDelete(volumeId: $volumeId)
      }`,
      { volumeId },
    );
    if (data.volumeDelete !== true) {
      throw new Error("Railway did not confirm volume deletion.");
    }
  }

  async deleteService(serviceId: string): Promise<void> {
    const data = await this.request<{ serviceDelete: boolean }>(
      `mutation serviceDelete($id: String!) {
        serviceDelete(id: $id)
      }`,
      { id: serviceId },
    );
    if (data.serviceDelete !== true) {
      throw new Error("Railway did not confirm service deletion.");
    }
  }
}

function railwayRetirementConfigurationError(
  options: RetireRailwayRuntimeOptions,
): RailwayRuntimeRetirementError | null {
  const needsCleanup =
    !options.serviceCleanupConfirmed || !options.volumeCleanupConfirmed;
  if (!needsCleanup) return null;
  if (!options.config.projectToken) {
    return new RailwayRuntimeRetirementError(
      "configuration",
      "WORKLIN_RAILWAY_PROJECT_TOKEN is required for runtime cleanup.",
    );
  }
  if (!options.config.projectId) {
    return new RailwayRuntimeRetirementError(
      "configuration",
      "WORKLIN_RAILWAY_PROJECT_ID is required for runtime cleanup.",
    );
  }
  if (!options.config.controlPlaneServiceId) {
    return new RailwayRuntimeRetirementError(
      "configuration",
      "RAILWAY_SERVICE_ID is required to protect the control-plane service.",
    );
  }
  if (
    options.config.provisioningLeaseTtlMs <= options.config.requestTimeoutMs
  ) {
    return new RailwayRuntimeRetirementError(
      "configuration",
      "The Railway cleanup lease TTL must exceed the API request timeout.",
    );
  }
  if (
    options.serviceId &&
    options.serviceId === options.config.controlPlaneServiceId
  ) {
    return new RailwayRuntimeRetirementError(
      "protected_service",
      "Refusing to delete the Railway control-plane service.",
    );
  }
  if (!options.volumeCleanupConfirmed && !options.serviceId) {
    return new RailwayRuntimeRetirementError(
      "configuration",
      "A persisted runtime service is required to verify volume ownership.",
    );
  }
  if (!options.volumeCleanupConfirmed && !options.volumeId) {
    return new RailwayRuntimeRetirementError(
      "cleanup_unconfirmed",
      "The Railway volume cleanup outcome cannot be reconciled without its persisted ID.",
    );
  }
  if (!options.serviceCleanupConfirmed && !options.serviceId) {
    return new RailwayRuntimeRetirementError(
      "cleanup_unconfirmed",
      "The Railway service cleanup outcome cannot be reconciled without its persisted ID.",
    );
  }
  return null;
}

async function reconcileRailwayDeletion(
  client: RailwayGraphqlClient,
  resource: "service" | "volume",
  resourceId: string,
  deleteResource: () => Promise<void>,
): Promise<void> {
  const before = await client.projectResourceIds();
  const ids = resource === "service" ? before.serviceIds : before.volumeIds;
  if (!ids.has(resourceId)) return;

  try {
    await deleteResource();
  } catch (error) {
    try {
      const after = await client.projectResourceIds();
      const remainingIds =
        resource === "service" ? after.serviceIds : after.volumeIds;
      if (!remainingIds.has(resourceId)) return;
    } catch (reconcileError) {
      throw new RailwayRuntimeRetirementError(
        "cleanup_unconfirmed",
        `Railway ${resource} cleanup could not be confirmed.`,
        { cause: reconcileError },
      );
    }
    throw new RailwayRuntimeRetirementError(
      "cleanup_unconfirmed",
      `Railway ${resource} cleanup failed and the resource still exists.`,
      { cause: error },
    );
  }
}

export async function retireRailwayRuntime(
  options: RetireRailwayRuntimeOptions,
): Promise<void> {
  const configurationError = railwayRetirementConfigurationError(options);
  if (configurationError) throw configurationError;
  if (options.serviceCleanupConfirmed && options.volumeCleanupConfirmed) return;

  const client = new RailwayGraphqlClient(
    options.config,
    options.fetchImpl ?? fetch,
    options.persistence.renewLease,
  );
  if (!options.volumeCleanupConfirmed) {
    const volumeId = options.volumeId!;
    await reconcileRailwayDeletion(client, "volume", volumeId, () =>
      client.deleteVolume(volumeId),
    );
    options.persistence.confirmVolumeCleanup();
  }
  if (!options.serviceCleanupConfirmed) {
    const serviceId = options.serviceId!;
    await reconcileRailwayDeletion(client, "service", serviceId, () =>
      client.deleteService(serviceId),
    );
    options.persistence.confirmServiceCleanup();
  }
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function waitForDeployment(
  client: RailwayGraphqlClient,
  deploymentId: string,
  config: RailwayProvisionerConfig,
  sleep: Sleep,
  now: () => number,
): Promise<void> {
  const deadline = now() + config.deployTimeoutMs;
  while (now() < deadline) {
    const status = await client.deploymentStatus(deploymentId);
    if (SUCCESSFUL_DEPLOYMENT_STATUSES.has(status)) return;
    if (FAILED_DEPLOYMENT_STATUSES.has(status)) {
      throw new Error(`Railway deployment ended with status ${status}.`);
    }
    await sleep(config.pollIntervalMs);
  }
  throw new Error("Railway deployment timed out before becoming successful.");
}

async function waitForServiceReconciliation(
  client: RailwayGraphqlClient,
  serviceName: string,
  config: RailwayProvisionerConfig,
  sleep: Sleep,
): Promise<string | null> {
  const attempts = Math.max(
    1,
    Math.ceil(config.serviceReconcileTimeoutMs / config.pollIntervalMs) + 1,
  );
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const existing = await client.findServiceByName(serviceName);
    if (existing) return existing;
    if (attempt + 1 < attempts) {
      await sleep(config.pollIntervalMs);
    }
  }
  return null;
}

async function waitForVolumeReconciliation(
  client: RailwayGraphqlClient,
  serviceId: string,
  config: RailwayProvisionerConfig,
  sleep: Sleep,
): Promise<string | null> {
  const attempts = Math.max(
    1,
    Math.ceil(config.serviceReconcileTimeoutMs / config.pollIntervalMs) + 1,
  );
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const existing = await client.findVolumeForService(serviceId);
    if (existing) return existing;
    if (attempt + 1 < attempts) {
      await sleep(config.pollIntervalMs);
    }
  }
  return null;
}

async function waitForHealth(
  gatewayUrl: string,
  config: RailwayProvisionerConfig,
  fetchImpl: FetchLike,
  sleep: Sleep,
  now: () => number,
  beforeRequest: () => void,
): Promise<string> {
  const deadline = now() + config.healthTimeoutMs;
  let lastStatus = "unreachable";
  while (now() < deadline) {
    beforeRequest();
    try {
      const response = await fetchImpl(`${gatewayUrl}/readyz`, {
        signal: AbortSignal.timeout(Math.min(config.pollIntervalMs, 5_000)),
      });
      lastStatus = String(response.status);
      if (response.ok) return lastStatus;
    } catch {
      lastStatus = "unreachable";
    }
    await sleep(config.pollIntervalMs);
  }
  throw new Error(
    `Railway runtime health check timed out (last status: ${lastStatus}).`,
  );
}

export async function provisionRailwayRuntime(
  options: ProvisionRailwayRuntimeOptions,
): Promise<void> {
  const configurationError = railwayProvisionerConfigurationError(
    options.config,
  );
  if (configurationError) throw new Error(configurationError);
  if (!/^[0-9a-f]{64}$/i.test(options.runtimeActorSigningKey)) {
    throw new Error("ACTOR_TOKEN_SIGNING_KEY must be 64 hex characters.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const client = new RailwayGraphqlClient(
    options.config,
    fetchImpl,
    options.persistence.renewLease,
  );
  const serviceName = railwayRuntimeServiceName(options.assistant.id);
  let serviceId = options.stack.service_ref;
  let volumeId = options.stack.workspace_volume_ref;

  if (!serviceId) {
    serviceId = await client.findServiceByName(serviceName);
    if (!serviceId && options.stack.service_create_attempted_at !== null) {
      serviceId = await waitForServiceReconciliation(
        client,
        serviceName,
        options.config,
        sleep,
      );
      if (!serviceId) {
        throw new Error(
          "Railway service creation outcome remains uncertain; operator reconciliation is required before another create.",
        );
      }
    }
    if (!serviceId) {
      if (!options.allowServiceCreation) {
        throw new Error(
          `Railway runtime service limit (${options.config.maxRuntimeServices}) has been reached.`,
        );
      }
      options.persistence.recordServiceCreateAttempt(now());
      try {
        serviceId = await client.createService(serviceName);
      } catch {
        serviceId = await waitForServiceReconciliation(
          client,
          serviceName,
          options.config,
          sleep,
        );
        if (!serviceId) {
          throw new Error(
            "Railway service creation outcome is uncertain; retry will reconcile before another create.",
          );
        }
      }
    }
    options.persistence.recordService(serviceId);
  }
  if (!volumeId) {
    volumeId = await client.findVolumeForService(serviceId);
    if (!volumeId && options.stack.volume_create_attempted_at !== null) {
      volumeId = await waitForVolumeReconciliation(
        client,
        serviceId,
        options.config,
        sleep,
      );
      if (!volumeId) {
        throw new Error(
          "Railway volume creation outcome remains uncertain; operator reconciliation is required before another create.",
        );
      }
    }
    if (!volumeId) {
      options.persistence.recordVolumeCreateAttempt(now());
      try {
        volumeId = await client.createVolume(serviceId);
      } catch {
        volumeId = await waitForVolumeReconciliation(
          client,
          serviceId,
          options.config,
          sleep,
        );
        if (!volumeId) {
          throw new Error(
            "Railway volume creation outcome is uncertain; retry will reconcile before another create.",
          );
        }
      }
    }
    options.persistence.recordVolume(volumeId);
  }

  const gatewayUrl = `http://${serviceName}.railway.internal:${options.config.runtimePort}`;
  await client.setVariables(serviceId, {
    WORKLIN_RUNTIME_MODE: "isolated",
    WORKLIN_REQUIRE_ISOLATED_RUNTIME: "true",
    WORKLIN_ALLOW_LEGACY_SHARED_RUNTIME: "false",
    WORKLIN_PLATFORM_ASSISTANT_ID: options.assistant.id,
    RUNTIME_ASSISTANT_SCOPE_MODE: "enforce",
    DEFAULT_ASSISTANT_ID: "self",
    UNMAPPED_POLICY: "default",
    ACTOR_TOKEN_SIGNING_KEY: options.runtimeActorSigningKey,
    CES_SERVICE_TOKEN: randomBytes(32).toString("hex"),
    WORKLIN_RUNTIME_ROOT: options.config.mountPath,
    VELLUM_WORKSPACE_DIR: `${options.config.mountPath}/workspace`,
    GATEWAY_SECURITY_DIR: `${options.config.mountPath}/gateway-security`,
    CES_DATA_DIR: `${options.config.mountPath}/ces-data`,
    CREDENTIAL_SECURITY_DIR: `${options.config.mountPath}/ces-data/security`,
  });

  const deploymentId = await client.deploy(serviceId);
  await waitForDeployment(client, deploymentId, options.config, sleep, now);
  const healthStatus = await waitForHealth(
    gatewayUrl,
    options.config,
    fetchImpl,
    sleep,
    now,
    options.persistence.renewLease,
  );
  options.persistence.markActive(gatewayUrl, healthStatus);
}
