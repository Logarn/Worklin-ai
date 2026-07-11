import { randomBytes } from "node:crypto";

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
  pollIntervalMs: number;
  deployTimeoutMs: number;
  healthTimeoutMs: number;
}

export interface RailwayProvisioningPersistence {
  recordService(serviceId: string): void;
  recordVolume(volumeId: string): void;
  markActive(gatewayUrl: string, healthStatus: string): void;
}

export interface ProvisionRailwayRuntimeOptions {
  assistant: AssistantRuntimeRow;
  stack: RuntimeStackRow;
  actorSigningKey: string;
  config: RailwayProvisionerConfig;
  persistence: RailwayProvisioningPersistence;
  fetchImpl?: FetchLike;
  sleep?: Sleep;
  now?: () => number;
}

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
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
  return null;
}

export function railwayRuntimeServiceName(assistantId: string): string {
  const suffix = assistantId
    .toLowerCase()
    .replace(/^worklin-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return `worklin-runtime-${suffix || "assistant"}`;
}

class RailwayGraphqlClient {
  constructor(
    private readonly config: RailwayProvisionerConfig,
    private readonly fetchImpl: FetchLike,
  ) {}

  async request<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.fetchImpl(this.config.apiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Project-Access-Token": this.config.projectToken,
      },
      body: JSON.stringify({ query, variables }),
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
    const data = await this.request<{ serviceInstanceDeploy: string }>(
      `mutation serviceInstanceDeploy($environmentId: String!, $serviceId: String!) {
        serviceInstanceDeploy(
          environmentId: $environmentId
          serviceId: $serviceId
        )
      }`,
      {
        environmentId: this.config.environmentId,
        serviceId,
      },
    );
    return data.serviceInstanceDeploy;
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

async function waitForHealth(
  gatewayUrl: string,
  config: RailwayProvisionerConfig,
  fetchImpl: FetchLike,
  sleep: Sleep,
  now: () => number,
): Promise<string> {
  const deadline = now() + config.healthTimeoutMs;
  let lastStatus = "unreachable";
  while (now() < deadline) {
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
  if (!/^[0-9a-f]{64}$/i.test(options.actorSigningKey)) {
    throw new Error("ACTOR_TOKEN_SIGNING_KEY must be 64 hex characters.");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const client = new RailwayGraphqlClient(options.config, fetchImpl);
  const serviceName = railwayRuntimeServiceName(options.assistant.id);
  let serviceId = options.stack.service_ref;
  let volumeId = options.stack.workspace_volume_ref;

  if (!serviceId) {
    serviceId = await client.createService(serviceName);
    options.persistence.recordService(serviceId);
  }
  if (!volumeId) {
    volumeId = await client.createVolume(serviceId);
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
    ACTOR_TOKEN_SIGNING_KEY: options.actorSigningKey,
    CES_SERVICE_TOKEN: randomBytes(32).toString("hex"),
    WORKLIN_RUNTIME_ROOT: options.config.mountPath,
    VELLUM_WORKSPACE_DIR: `${options.config.mountPath}/workspace`,
  });

  const deploymentId = await client.deploy(serviceId);
  await waitForDeployment(client, deploymentId, options.config, sleep, now);
  const healthStatus = await waitForHealth(
    gatewayUrl,
    options.config,
    fetchImpl,
    sleep,
    now,
  );
  options.persistence.markActive(gatewayUrl, healthStatus);
}
