import {
  railwayProvisionerConfigurationError,
  type RailwayProvisionerConfig,
} from "./railway-runtime-provisioner.js";

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

type FetchLike = typeof fetch;

export interface RequestRailwayRuntimeRestartOptions {
  serviceId: string;
  config: RailwayProvisionerConfig;
  fetchImpl?: FetchLike;
}

async function railwayGraphql<T>(
  options: RequestRailwayRuntimeRestartOptions,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await (options.fetchImpl ?? fetch)(
    options.config.apiEndpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Project-Access-Token": options.config.projectToken,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(options.config.requestTimeoutMs),
    },
  );
  const payload = (await response.json()) as GraphqlEnvelope<T>;
  const detail = payload.errors
    ?.map((error) => error.message || "Unknown Railway API error")
    .join("; ");
  if (!response.ok || detail || payload.data == null) {
    throw new Error(
      `Railway API request failed (${response.status}): ${detail || response.statusText}`,
    );
  }
  return payload.data;
}

export async function requestRailwayRuntimeRestart(
  options: RequestRailwayRuntimeRestartOptions,
): Promise<string> {
  const configurationError = railwayProvisionerConfigurationError(
    options.config,
  );
  if (configurationError) throw new Error(configurationError);
  if (!options.serviceId) throw new Error("Railway service ID is required.");

  const latest = await railwayGraphql<{
    deployments?: {
      edges?: Array<{
        node?: { id?: string; status?: string } | null;
      }>;
    } | null;
  }>(
    options,
    `query latestActiveDeployment($input: DeploymentListInput!) {
      deployments(input: $input, first: 1) {
        edges {
          node {
            id
            status
          }
        }
      }
    }`,
    {
      input: {
        projectId: options.config.projectId,
        environmentId: options.config.environmentId,
        serviceId: options.serviceId,
        status: { successfulOnly: true },
      },
    },
  );
  const deployment = latest.deployments?.edges?.[0]?.node;
  const deploymentId = deployment?.id?.trim();
  if (!deploymentId || deployment?.status?.toUpperCase() !== "SUCCESS") {
    throw new Error(
      "Railway has no active successful deployment for this runtime service.",
    );
  }

  const restarted = await railwayGraphql<{ deploymentRestart?: boolean }>(
    options,
    `mutation deploymentRestart($id: String!) {
      deploymentRestart(id: $id)
    }`,
    { id: deploymentId },
  );
  if (restarted.deploymentRestart !== true) {
    throw new Error("Railway did not confirm the deployment restart.");
  }

  return deploymentId;
}
