import { describe, expect, test } from "bun:test";

import {
  BoundedKeyedTaskScheduler,
  provisionRailwayRuntime,
  railwayProvisionerConfigurationError,
  railwayProvisionerConfigFromEnv,
  railwayRuntimeCapacityError,
  railwayRuntimeServiceName,
  type RailwayProvisionerConfig,
} from "./railway-runtime-provisioner.js";
import type { AssistantRuntimeRow, RuntimeStackRow } from "./runtime-stacks.js";

const assistant: AssistantRuntimeRow = {
  id: "worklin-52d71495-bab5-4567-bcfc-832cc2bb15fe",
  user_id: "user-1",
  org_id: "org-1",
  runtime_stack_id: "rt-1",
};

function stack(overrides: Partial<RuntimeStackRow> = {}): RuntimeStackRow {
  return {
    id: "rt-1",
    org_id: "org-1",
    assistant_id: assistant.id,
    status: "provisioning",
    provider: "railway",
    gateway_url: null,
    public_ingress_url: "https://worklin.example.com",
    workspace_volume_ref: null,
    service_ref: null,
    service_capacity_reserved: 0,
    actor_signing_key_scope: "runtime_v1:rt-1",
    last_health_status: null,
    last_error: null,
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

function config(
  overrides: Partial<RailwayProvisionerConfig> = {},
): RailwayProvisionerConfig {
  return {
    enabled: true,
    apiEndpoint: "https://backboard.railway.test/graphql/v2",
    projectToken: "project-token",
    projectId: "project-1",
    environmentId: "environment-1",
    repository: "Logarn/Worklin-ai",
    branch: "main",
    region: null,
    mountPath: "/data",
    runtimePort: 8080,
    maxRuntimeServices: 2,
    maxConcurrentProvisioning: 2,
    pollIntervalMs: 10,
    deployTimeoutMs: 100,
    healthTimeoutMs: 100,
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

describe("railwayProvisionerConfigFromEnv", () => {
  test("is disabled and capped at zero by default", () => {
    const parsed = railwayProvisionerConfigFromEnv({});
    expect(parsed.enabled).toBe(false);
    expect(parsed.maxRuntimeServices).toBe(0);
    expect(railwayProvisionerConfigurationError(parsed)).toContain("disabled");
  });

  test("requires an explicit positive service cap", () => {
    const parsed = railwayProvisionerConfigFromEnv({
      WORKLIN_RAILWAY_PROVISIONING_ENABLED: "true",
      WORKLIN_RAILWAY_PROJECT_TOKEN: "token",
      WORKLIN_RAILWAY_PROJECT_ID: "project",
      WORKLIN_RAILWAY_ENVIRONMENT_ID: "environment",
    });
    expect(railwayProvisionerConfigurationError(parsed)).toContain(
      "MAX_RUNTIME_SERVICES",
    );
  });
});

describe("railwayRuntimeServiceName", () => {
  test("creates a stable DNS-safe service name within Railway's limit", () => {
    expect(railwayRuntimeServiceName(assistant.id)).toBe(
      "worklin-rt-52d71495-4bde2f6aeafa",
    );
    expect(railwayRuntimeServiceName(assistant.id).length).toBeLessThanOrEqual(
      32,
    );
    expect(railwayRuntimeServiceName("asst-1")).toBe("worklin-runtime-asst-1");
  });

  test("keeps long assistant ids with the same prefix distinct", () => {
    const first = railwayRuntimeServiceName(
      "worklin-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    const second = railwayRuntimeServiceName(
      "worklin-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab",
    );
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(32);
    expect(second.length).toBeLessThanOrEqual(32);
  });
});

describe("BoundedKeyedTaskScheduler", () => {
  test("runs distinct stacks concurrently up to the configured bound", async () => {
    const scheduler = new BoundedKeyedTaskScheduler(2);
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    let scheduled = 0;

    const task = () => {
      scheduled += 1;
      return scheduler.schedule(`stack-${scheduled}`, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
      });
    };

    const completions = [task(), task(), task(), task()];
    await Bun.sleep(0);
    expect(active).toBe(2);
    expect(maxActive).toBe(2);

    releases.shift()?.();
    releases.shift()?.();
    await Bun.sleep(0);
    expect(active).toBe(2);

    releases.shift()?.();
    releases.shift()?.();
    await Promise.all(completions);
    expect(maxActive).toBe(2);
  });

  test("deduplicates the same runtime stack while it is queued or running", async () => {
    const scheduler = new BoundedKeyedTaskScheduler(1);
    let release!: () => void;
    let calls = 0;
    const first = scheduler.schedule("stack-1", async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const duplicate = scheduler.schedule("stack-1", async () => {
      calls += 1;
    });

    expect(duplicate).toBe(first);
    await Bun.sleep(0);
    expect(calls).toBe(1);
    release();
    await first;
  });
});

describe("railwayRuntimeCapacityError", () => {
  test("blocks a new runtime at the configured cap", () => {
    expect(railwayRuntimeCapacityError(null, 2, 2)).toBe(
      "Railway runtime service limit (2) has been reached.",
    );
  });

  test("allows capacity below the cap and resumable existing services", () => {
    expect(railwayRuntimeCapacityError(null, 1, 2)).toBeNull();
    expect(railwayRuntimeCapacityError("service-1", 2, 2)).toBeNull();
  });
});

describe("provisionRailwayRuntime", () => {
  test("creates an isolated service, volume, variables, deployment, and health route", async () => {
    const graphqlOperations: Array<{
      query: string;
      variables: Record<string, unknown>;
    }> = [];
    let deploymentPolls = 0;
    let healthPolls = 0;
    let clock = 0;
    const fetchImpl = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/readyz")) {
        healthPolls += 1;
        return healthPolls === 1
          ? jsonResponse({ status: "starting" }, 503)
          : jsonResponse({ status: "ok" });
      }

      const request = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      graphqlOperations.push(request);
      if (request.query.includes("runtimeProjectServices")) {
        return jsonResponse({
          data: { project: { services: { edges: [] } } },
        });
      }
      if (request.query.includes("serviceCreate")) {
        return jsonResponse({ data: { serviceCreate: { id: "service-1" } } });
      }
      if (request.query.includes("runtimeEnvironmentConfig")) {
        return jsonResponse({
          data: { environment: { config: { services: {} } } },
        });
      }
      if (request.query.includes("volumeCreate")) {
        return jsonResponse({ data: { volumeCreate: { id: "volume-1" } } });
      }
      if (request.query.includes("variableCollectionUpsert")) {
        return jsonResponse({ data: { variableCollectionUpsert: true } });
      }
      if (request.query.includes("serviceInstanceDeploy")) {
        return jsonResponse({ data: { serviceInstanceDeploy: "deploy-1" } });
      }
      if (request.query.includes("query deployment")) {
        deploymentPolls += 1;
        return jsonResponse({
          data: {
            deployment: {
              status: deploymentPolls === 1 ? "BUILDING" : "SUCCESS",
            },
          },
        });
      }
      throw new Error(`Unexpected GraphQL operation: ${request.query}`);
    }) as typeof fetch;

    const events: string[] = [];
    await provisionRailwayRuntime({
      assistant,
      stack: stack(),
      runtimeActorSigningKey: "a".repeat(64),
      allowServiceCreation: true,
      config: config(),
      fetchImpl,
      sleep: async (delayMs) => {
        clock += delayMs;
      },
      now: () => clock,
      persistence: {
        recordService: (id) => events.push(`service:${id}`),
        recordVolume: (id) => events.push(`volume:${id}`),
        markActive: (url, status) => events.push(`active:${url}:${status}`),
      },
    });

    expect(events).toEqual([
      "service:service-1",
      "volume:volume-1",
      "active:http://worklin-rt-52d71495-4bde2f6aeafa.railway.internal:8080:200",
    ]);
    expect(deploymentPolls).toBe(2);
    expect(healthPolls).toBe(2);

    const variablesMutation = graphqlOperations.find((operation) =>
      operation.query.includes("variableCollectionUpsert"),
    );
    const input = variablesMutation?.variables.input as {
      variables: Record<string, string>;
      skipDeploys: boolean;
    };
    expect(input.skipDeploys).toBe(true);
    expect(input.variables).toMatchObject({
      WORKLIN_RUNTIME_MODE: "isolated",
      WORKLIN_PLATFORM_ASSISTANT_ID: assistant.id,
      RUNTIME_ASSISTANT_SCOPE_MODE: "enforce",
      ACTOR_TOKEN_SIGNING_KEY: "a".repeat(64),
    });
    expect(input.variables.CES_SERVICE_TOKEN).toHaveLength(64);
    expect(
      graphqlOperations.map((operation) => {
        if (operation.query.includes("runtimeProjectServices"))
          return "service-lookup";
        if (operation.query.includes("serviceCreate")) return "service";
        if (operation.query.includes("runtimeEnvironmentConfig"))
          return "volume-lookup";
        if (operation.query.includes("volumeCreate")) return "volume";
        if (operation.query.includes("variableCollectionUpsert"))
          return "variables";
        if (operation.query.includes("serviceInstanceDeploy")) return "deploy";
        return "status";
      }),
    ).toEqual([
      "service-lookup",
      "service",
      "volume-lookup",
      "volume",
      "variables",
      "deploy",
      "status",
      "status",
    ]);
  });

  test("recovers service and volume identities after create response loss", async () => {
    let serviceCreated = false;
    let volumeCreated = false;
    let serviceCreateCalls = 0;
    let volumeCreateCalls = 0;
    const fetchImpl = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/readyz")) {
        return jsonResponse({ status: "ok" });
      }
      const request = JSON.parse(String(init?.body)) as {
        query: string;
      };
      if (request.query.includes("runtimeProjectServices")) {
        return jsonResponse({
          data: {
            project: {
              services: {
                edges: serviceCreated
                  ? [
                      {
                        node: {
                          id: "service-recovered",
                          name: railwayRuntimeServiceName(assistant.id),
                        },
                      },
                    ]
                  : [],
              },
            },
          },
        });
      }
      if (request.query.includes("serviceCreate")) {
        serviceCreateCalls += 1;
        serviceCreated = true;
        throw new TypeError("simulated response loss");
      }
      if (request.query.includes("runtimeEnvironmentConfig")) {
        return jsonResponse({
          data: {
            environment: {
              config: {
                services: {
                  "service-recovered": {
                    volumeMounts: volumeCreated
                      ? { "volume-recovered": { mountPath: "/data" } }
                      : {},
                  },
                },
              },
            },
          },
        });
      }
      if (request.query.includes("volumeCreate")) {
        volumeCreateCalls += 1;
        volumeCreated = true;
        throw new TypeError("simulated response loss");
      }
      if (request.query.includes("variableCollectionUpsert")) {
        return jsonResponse({ data: { variableCollectionUpsert: true } });
      }
      if (request.query.includes("serviceInstanceDeploy")) {
        return jsonResponse({ data: { serviceInstanceDeploy: "deploy-1" } });
      }
      if (request.query.includes("query deployment")) {
        return jsonResponse({ data: { deployment: { status: "SUCCESS" } } });
      }
      throw new Error(`Unexpected GraphQL operation: ${request.query}`);
    }) as typeof fetch;

    const events: string[] = [];
    await provisionRailwayRuntime({
      assistant,
      stack: stack(),
      runtimeActorSigningKey: "c".repeat(64),
      allowServiceCreation: true,
      config: config(),
      fetchImpl,
      sleep: async () => {},
      now: () => 0,
      persistence: {
        recordService: (id) => events.push(`service:${id}`),
        recordVolume: (id) => events.push(`volume:${id}`),
        markActive: (url, status) => events.push(`active:${url}:${status}`),
      },
    });

    expect(serviceCreateCalls).toBe(1);
    expect(volumeCreateCalls).toBe(1);
    expect(events).toEqual([
      "service:service-recovered",
      "volume:volume-recovered",
      "active:http://worklin-rt-52d71495-4bde2f6aeafa.railway.internal:8080:200",
    ]);
  });

  test("reconciles an orphaned service at the cap without creating another", async () => {
    let serviceCreateCalls = 0;
    const fetchImpl = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/readyz")) {
        return jsonResponse({ status: "ok" });
      }
      const request = JSON.parse(String(init?.body)) as { query: string };
      if (request.query.includes("runtimeProjectServices")) {
        return jsonResponse({
          data: {
            project: {
              services: {
                edges: [
                  {
                    node: {
                      id: "service-orphaned",
                      name: railwayRuntimeServiceName(assistant.id),
                    },
                  },
                ],
              },
            },
          },
        });
      }
      if (request.query.includes("serviceCreate")) {
        serviceCreateCalls += 1;
        throw new Error("service creation must remain blocked at the cap");
      }
      if (request.query.includes("runtimeEnvironmentConfig")) {
        return jsonResponse({
          data: {
            environment: {
              config: {
                services: {
                  "service-orphaned": {
                    volumeMounts: {
                      "volume-orphaned": { mountPath: "/data" },
                    },
                  },
                },
              },
            },
          },
        });
      }
      if (request.query.includes("variableCollectionUpsert")) {
        return jsonResponse({ data: { variableCollectionUpsert: true } });
      }
      if (request.query.includes("serviceInstanceDeploy")) {
        return jsonResponse({ data: { serviceInstanceDeploy: "deploy-1" } });
      }
      if (request.query.includes("query deployment")) {
        return jsonResponse({ data: { deployment: { status: "SUCCESS" } } });
      }
      throw new Error(`Unexpected GraphQL operation: ${request.query}`);
    }) as typeof fetch;

    const events: string[] = [];
    await provisionRailwayRuntime({
      assistant,
      stack: stack(),
      runtimeActorSigningKey: "d".repeat(64),
      allowServiceCreation: false,
      config: config(),
      fetchImpl,
      sleep: async () => {},
      now: () => 0,
      persistence: {
        recordService: (id) => events.push(`service:${id}`),
        recordVolume: (id) => events.push(`volume:${id}`),
        markActive: (url, status) => events.push(`active:${url}:${status}`),
      },
    });

    expect(serviceCreateCalls).toBe(0);
    expect(events).toEqual([
      "service:service-orphaned",
      "volume:volume-orphaned",
      "active:http://worklin-rt-52d71495-4bde2f6aeafa.railway.internal:8080:200",
    ]);
  });

  test("fails at the cap only after confirming no matching service exists", async () => {
    let serviceLookups = 0;
    let serviceCreateCalls = 0;
    const fetchImpl = (async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      if (request.query.includes("runtimeProjectServices")) {
        serviceLookups += 1;
        return jsonResponse({
          data: { project: { services: { edges: [] } } },
        });
      }
      if (request.query.includes("serviceCreate")) {
        serviceCreateCalls += 1;
      }
      throw new Error(`Unexpected GraphQL operation: ${request.query}`);
    }) as typeof fetch;

    await expect(
      provisionRailwayRuntime({
        assistant,
        stack: stack(),
        runtimeActorSigningKey: "e".repeat(64),
        allowServiceCreation: false,
        config: config({ maxRuntimeServices: 2 }),
        fetchImpl,
        persistence: {
          recordService: () => {},
          recordVolume: () => {},
          markActive: () => {},
        },
      }),
    ).rejects.toThrow("service limit (2) has been reached");
    expect(serviceLookups).toBe(1);
    expect(serviceCreateCalls).toBe(0);
  });

  test("reuses persisted service and volume references after a partial attempt", async () => {
    const operations: string[] = [];
    const fetchImpl = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/readyz")) {
        return jsonResponse({ status: "ok" });
      }
      const request = JSON.parse(String(init?.body)) as { query: string };
      operations.push(request.query);
      if (request.query.includes("variableCollectionUpsert")) {
        return jsonResponse({ data: { variableCollectionUpsert: true } });
      }
      if (request.query.includes("serviceInstanceDeploy")) {
        return jsonResponse({ data: { serviceInstanceDeploy: "deploy-1" } });
      }
      if (request.query.includes("query deployment")) {
        return jsonResponse({ data: { deployment: { status: "SUCCESS" } } });
      }
      throw new Error(`Unexpected GraphQL operation: ${request.query}`);
    }) as typeof fetch;

    await provisionRailwayRuntime({
      assistant,
      stack: stack({
        service_ref: "service-existing",
        workspace_volume_ref: "volume-existing",
      }),
      runtimeActorSigningKey: "b".repeat(64),
      allowServiceCreation: true,
      config: config(),
      fetchImpl,
      sleep: async () => {},
      now: () => 0,
      persistence: {
        recordService: () => {
          throw new Error("service should be reused");
        },
        recordVolume: () => {
          throw new Error("volume should be reused");
        },
        markActive: () => {},
      },
    });

    expect(operations.some((query) => query.includes("serviceCreate"))).toBe(
      false,
    );
    expect(operations.some((query) => query.includes("volumeCreate"))).toBe(
      false,
    );
  });
});
