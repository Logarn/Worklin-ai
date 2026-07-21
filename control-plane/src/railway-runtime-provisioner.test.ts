import { describe, expect, test } from "bun:test";

import {
  BoundedKeyedTaskScheduler,
  provisionRailwayRuntime,
  RailwayRuntimeRetirementError,
  retireRailwayRuntime,
  railwayProvisionerConfigurationError,
  railwayProvisionerConfigFromEnv,
  railwayRuntimeCapacityError,
  railwayRuntimeWorkspaceCapacityError,
  railwayRuntimeServiceName,
  type RailwayProvisioningPersistence,
  type RailwayProvisionerConfig,
  type RailwayRuntimeRetirementPersistence,
  type RetireRailwayRuntimeOptions,
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
    service_create_attempted_at: null,
    volume_create_attempted_at: null,
    provisioning_lease_token: null,
    provisioning_lease_expires_at: null,
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
    requestTimeoutMs: 50,
    serviceReconcileTimeoutMs: 20,
    provisioningLeaseTtlMs: 1_000,
    pollIntervalMs: 10,
    deployTimeoutMs: 100,
    healthTimeoutMs: 100,
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function makePersistence(
  overrides: Partial<RailwayProvisioningPersistence> = {},
): RailwayProvisioningPersistence {
  return {
    renewLease: () => {},
    recordServiceCreateAttempt: () => {},
    recordVolumeCreateAttempt: () => {},
    recordService: () => {},
    recordVolume: () => {},
    markActive: () => {},
    ...overrides,
  };
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

describe("railwayRuntimeWorkspaceCapacityError", () => {
  test("limits a workspace independently of the global cap", () => {
    expect(railwayRuntimeWorkspaceCapacityError(null, 1, 1)).toContain(
      "workspace quota",
    );
    expect(railwayRuntimeWorkspaceCapacityError("service-1", 1, 1)).toBeNull();
  });
});

type RetirementRailwayState = {
  services: Map<string, string>;
  volumes: Set<string>;
  mounts: Map<string, Set<string>>;
  variables: Map<string, Record<string, string>>;
  operations: string[];
  failServiceDelete: boolean;
};

const retirementServiceName = railwayRuntimeServiceName(assistant.id, "rt-1");
const ownershipVariables = {
  WORKLIN_PLATFORM_ASSISTANT_ID: assistant.id,
  WORKLIN_RUNTIME_STACK_ID: "rt-1",
  WORKLIN_RUNTIME_OWNERSHIP: "worklin-isolated-runtime-v1",
};

function retirementRailway(
  overrides: Partial<RetirementRailwayState> = {},
): RetirementRailwayState & { fetch: typeof fetch } {
  const state: RetirementRailwayState = {
    services: new Map([
      ["service-1", retirementServiceName],
      ["control-plane-service", "control-plane"],
    ]),
    volumes: new Set(["volume-1"]),
    mounts: new Map([["service-1", new Set(["volume-1"])]]),
    variables: new Map([["service-1", { ...ownershipVariables }]]),
    operations: [],
    failServiceDelete: false,
    ...overrides,
  };
  const fetchImpl = (async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, any>;
    };
    expect(new Headers(init?.headers).get("Project-Access-Token")).toBe(
      "project-token",
    );
    if (request.query.includes("runtimeRetirementResources")) {
      state.operations.push("inventory");
      return jsonResponse({
        data: {
          project: {
            services: {
              edges: [...state.services].map(([id, name]) => ({
                node: { id, name },
              })),
            },
            volumes: {
              edges: [...state.volumes].map((id) => ({ node: { id } })),
            },
          },
        },
      });
    }
    if (request.query.includes("runtimeEnvironmentConfig")) {
      state.operations.push("environment");
      return jsonResponse({
        data: {
          environment: {
            config: {
              services: Object.fromEntries(
                [...state.services.keys()].map((serviceId) => [
                  serviceId,
                  {
                    volumeMounts: Object.fromEntries(
                      [...(state.mounts.get(serviceId) ?? [])].map((id) => [
                        id,
                        { mountPath: "/data" },
                      ]),
                    ),
                  },
                ]),
              ),
            },
          },
        },
      });
    }
    if (request.query.includes("runtimeOwnershipVariables")) {
      state.operations.push("variables");
      return jsonResponse({
        data: { variables: state.variables.get(request.variables.serviceId) ?? {} },
      });
    }
    if (request.query.includes("variableCollectionUpsert")) {
      state.operations.push("markOwnership");
      const input = request.variables.input as {
        serviceId: string;
        variables: Record<string, string>;
      };
      state.variables.set(input.serviceId, {
        ...(state.variables.get(input.serviceId) ?? {}),
        ...input.variables,
      });
      return jsonResponse({ data: { variableCollectionUpsert: true } });
    }
    if (request.query.includes("mutation volumeDelete")) {
      state.operations.push("volumeDelete");
      const volumeId = String(request.variables.volumeId);
      state.volumes.delete(volumeId);
      for (const mounts of state.mounts.values()) mounts.delete(volumeId);
      return jsonResponse({ data: { volumeDelete: true } });
    }
    if (request.query.includes("mutation serviceDelete")) {
      state.operations.push("serviceDelete");
      if (state.failServiceDelete) {
        return jsonResponse({ errors: [{ message: "service delete failed" }] });
      }
      state.services.delete(String(request.variables.id));
      return jsonResponse({ data: { serviceDelete: true } });
    }
    throw new Error("Unexpected Railway operation.");
  }) as typeof fetch;
  return Object.assign(state, { fetch: fetchImpl });
}

function retirementPersistence(
  events: string[],
  overrides: Partial<RailwayRuntimeRetirementPersistence> = {},
): RailwayRuntimeRetirementPersistence {
  return {
    renewLease: () => {},
    recordService: (id) => events.push(`recordService:${id}`),
    recordVolume: (id) => events.push(`recordVolume:${id}`),
    confirmVolumeCleanup: () => events.push("confirmVolume"),
    confirmServiceCleanup: () => events.push("confirmService"),
    ...overrides,
  };
}

function retirementOptions(
  railway: ReturnType<typeof retirementRailway>,
  events: string[],
  overrides: Partial<RetireRailwayRuntimeOptions> = {},
): RetireRailwayRuntimeOptions {
  return {
    assistantId: assistant.id,
    stackId: "rt-1",
    serviceId: "service-1",
    volumeId: "volume-1",
    serviceCreateAttempted: false,
    volumeCreateAttempted: false,
    serviceCleanupConfirmed: false,
    volumeCleanupConfirmed: false,
    config: config({ controlPlaneServiceId: "control-plane-service" }),
    persistence: retirementPersistence(events),
    fetchImpl: railway.fetch,
    ...overrides,
  };
}

describe("retireRailwayRuntime", () => {
  test("deletes only an exact owned volume and service", async () => {
    const railway = retirementRailway();
    const events: string[] = [];

    await retireRailwayRuntime(retirementOptions(railway, events));

    expect(railway.operations.filter((value) => value.endsWith("Delete"))).toEqual([
      "volumeDelete",
      "serviceDelete",
    ]);
    expect(events).toEqual(["confirmVolume", "confirmService"]);
    expect(railway.services.has("control-plane-service")).toBe(true);
  });

  test("rejects mismatched names, markers, and volume associations", async () => {
    const cases = [
      retirementRailway({
        services: new Map([["service-1", "shared-service"]]),
      }),
      retirementRailway({
        variables: new Map([
          ["service-1", { ...ownershipVariables, WORKLIN_RUNTIME_STACK_ID: "other" }],
        ]),
      }),
      retirementRailway({
        mounts: new Map([["service-1", new Set(["other-volume"])]]),
      }),
    ];

    for (const railway of cases) {
      await expect(
        retireRailwayRuntime(retirementOptions(railway, [])),
      ).rejects.toMatchObject({ code: "ownership_unverified" });
      expect(railway.operations).not.toContain("volumeDelete");
      expect(railway.operations).not.toContain("serviceDelete");
    }
  });

  test("reconciles exact service and volume attempts before cleanup", async () => {
    const railway = retirementRailway({
      variables: new Map([["service-1", {}]]),
    });
    const events: string[] = [];

    await retireRailwayRuntime(
      retirementOptions(railway, events, {
        serviceId: null,
        volumeId: null,
        serviceCreateAttempted: true,
        volumeCreateAttempted: true,
      }),
    );

    expect(events).toEqual([
      "recordService:service-1",
      "recordVolume:volume-1",
      "confirmVolume",
      "confirmService",
    ]);
    expect(railway.operations).toContain("markOwnership");
  });

  test("resolves pre-request attempt markers to confirmed absence", async () => {
    const railway = retirementRailway({
      services: new Map([["control-plane-service", "control-plane"]]),
      volumes: new Set(),
      mounts: new Map(),
      variables: new Map(),
    });
    const events: string[] = [];

    await retireRailwayRuntime(
      retirementOptions(railway, events, {
        serviceId: null,
        volumeId: null,
        serviceCreateAttempted: true,
        serviceCleanupConfirmed: false,
        volumeCleanupConfirmed: true,
      }),
    );

    expect(events).toEqual(["confirmService"]);
    expect(railway.operations).not.toContain("serviceDelete");
  });

  test("preserves partial cleanup and reconciles an absent service on retry", async () => {
    const railway = retirementRailway({ failServiceDelete: true });
    const events: string[] = [];
    await expect(
      retireRailwayRuntime(retirementOptions(railway, events)),
    ).rejects.toMatchObject({ code: "cleanup_unconfirmed" });
    expect(events).toEqual(["confirmVolume"]);

    railway.failServiceDelete = false;
    await retireRailwayRuntime(
      retirementOptions(railway, events, {
        volumeCleanupConfirmed: true,
        volumeId: "volume-1",
      }),
    );
    expect(events).toEqual(["confirmVolume", "confirmService"]);
  });

  test("fails safely when the retirement lease is lost in every cleanup phase", async () => {
    for (const failAt of [1, 3, 5, 7, 8, 9]) {
      const railway = retirementRailway();
      const events: string[] = [];
      let renewals = 0;
      const persistence = retirementPersistence(events, {
        renewLease: () => {
          renewals += 1;
          if (renewals === failAt) throw new Error("lease lost");
        },
      });
      await expect(
        retireRailwayRuntime(
          retirementOptions(railway, events, { persistence }),
        ),
      ).rejects.toThrow("lease lost");
      expect(events.at(-1)).not.toBe("confirmService");
    }
  });

  test("reconciles deletion when confirmation loses the lease", async () => {
    const railway = retirementRailway();
    let failConfirmation = true;
    const events: string[] = [];
    const persistence = retirementPersistence(events, {
      confirmVolumeCleanup: () => {
        if (failConfirmation) throw new Error("lease lost after volume delete");
        events.push("confirmVolume");
      },
    });
    await expect(
      retireRailwayRuntime(
        retirementOptions(railway, events, { persistence }),
      ),
    ).rejects.toThrow("lease lost after volume delete");
    expect(railway.volumes.has("volume-1")).toBe(false);

    failConfirmation = false;
    await retireRailwayRuntime(
      retirementOptions(railway, events, { persistence }),
    );
    expect(events).toEqual(["confirmVolume", "confirmService"]);
  });

  test("refuses the control-plane service before making a Railway request", async () => {
    const railway = retirementRailway();
    await expect(
      retireRailwayRuntime(
        retirementOptions(railway, [], {
          serviceId: "control-plane-service",
        }),
      ),
    ).rejects.toBeInstanceOf(RailwayRuntimeRetirementError);
    expect(railway.operations).toHaveLength(0);
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
      if (request.query.includes("variableCollectionUpsert")) {
        return jsonResponse({ data: { variableCollectionUpsert: true } });
      }
      if (request.query.includes("runtimeEnvironmentConfig")) {
        return jsonResponse({
          data: { environment: { config: { services: {} } } },
        });
      }
      if (request.query.includes("volumeCreate")) {
        return jsonResponse({ data: { volumeCreate: { id: "volume-1" } } });
      }
      if (request.query.includes("serviceInstanceDeployV2")) {
        return jsonResponse({ data: { serviceInstanceDeployV2: "deploy-1" } });
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
      config: config({ mountPath: "/runtime/customer" }),
      fetchImpl,
      sleep: async (delayMs) => {
        clock += delayMs;
      },
      now: () => clock,
      persistence: makePersistence({
        recordService: (id) => events.push(`service:${id}`),
        recordVolume: (id) => events.push(`volume:${id}`),
        markActive: (url, status) => events.push(`active:${url}:${status}`),
      }),
    });

    expect(events).toEqual([
      "service:service-1",
      "volume:volume-1",
      `active:http://${railwayRuntimeServiceName(assistant.id, "rt-1")}.railway.internal:8080:200`,
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
      WORKLIN_RUNTIME_STACK_ID: "rt-1",
      WORKLIN_RUNTIME_OWNERSHIP: "worklin-isolated-runtime-v1",
      RUNTIME_ASSISTANT_SCOPE_MODE: "enforce",
      ACTOR_TOKEN_SIGNING_KEY: "a".repeat(64),
      WORKLIN_RUNTIME_ROOT: "/runtime/customer",
      VELLUM_WORKSPACE_DIR: "/runtime/customer/workspace",
      GATEWAY_SECURITY_DIR: "/runtime/customer/gateway-security",
      CES_DATA_DIR: "/runtime/customer/ces-data",
      CREDENTIAL_SECURITY_DIR: "/runtime/customer/ces-data/security",
    });
    expect(input.variables.CES_SERVICE_TOKEN).toHaveLength(64);
    const volumeMutation = graphqlOperations.find((operation) =>
      operation.query.includes("volumeCreate"),
    );
    expect(
      (volumeMutation?.variables.input as { mountPath?: string }).mountPath,
    ).toBe("/runtime/customer");
    const deployMutation = graphqlOperations.find((operation) =>
      operation.query.includes("serviceInstanceDeployV2"),
    );
    expect(deployMutation?.query).toContain(
      "mutation serviceInstanceDeployV2",
    );
    expect(deployMutation?.query).not.toContain("serviceInstanceDeploy(");
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
        if (operation.query.includes("serviceInstanceDeployV2"))
          return "deploy";
        return "status";
      }),
    ).toEqual([
      "service-lookup",
      "service",
      "variables",
      "volume-lookup",
      "volume",
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
                          name: railwayRuntimeServiceName(assistant.id, "rt-1"),
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
      if (request.query.includes("variableCollectionUpsert")) {
        return jsonResponse({ data: { variableCollectionUpsert: true } });
      }
      if (request.query.includes("volumeCreate")) {
        volumeCreateCalls += 1;
        volumeCreated = true;
        throw new TypeError("simulated response loss");
      }
      if (request.query.includes("serviceInstanceDeployV2")) {
        return jsonResponse({ data: { serviceInstanceDeployV2: "deploy-1" } });
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
      persistence: makePersistence({
        recordService: (id) => events.push(`service:${id}`),
        recordVolume: (id) => events.push(`volume:${id}`),
        markActive: (url, status) => events.push(`active:${url}:${status}`),
      }),
    });

    expect(serviceCreateCalls).toBe(1);
    expect(volumeCreateCalls).toBe(1);
    expect(events).toEqual([
      "service:service-recovered",
      "volume:volume-recovered",
      `active:http://${railwayRuntimeServiceName(assistant.id, "rt-1")}.railway.internal:8080:200`,
    ]);
  });

  test("never creates again automatically after an ambiguous response", async () => {
    let serviceCreateCalls = 0;
    let firstLookupCalls = 0;
    const firstFetch = (async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      if (request.query.includes("runtimeProjectServices")) {
        firstLookupCalls += 1;
        return jsonResponse({
          data: { project: { services: { edges: [] } } },
        });
      }
      if (request.query.includes("serviceCreate")) {
        serviceCreateCalls += 1;
        throw new TypeError("simulated ambiguous response loss");
      }
      throw new Error(`Unexpected GraphQL operation: ${request.query}`);
    }) as typeof fetch;
    const firstEvents: string[] = [];

    await expect(
      provisionRailwayRuntime({
        assistant,
        stack: stack(),
        runtimeActorSigningKey: "f".repeat(64),
        allowServiceCreation: true,
        config: config(),
        fetchImpl: firstFetch,
        sleep: async () => {},
        now: () => 100,
        persistence: makePersistence({
          recordServiceCreateAttempt: () => firstEvents.push("service-attempt"),
        }),
      }),
    ).rejects.toThrow("creation outcome is uncertain");
    expect(firstLookupCalls).toBe(4);
    expect(serviceCreateCalls).toBe(1);
    expect(firstEvents).toEqual(["service-attempt"]);

    let secondLookupCalls = 0;
    const secondFetch = (async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      if (request.query.includes("runtimeProjectServices")) {
        secondLookupCalls += 1;
        return jsonResponse({
          data: { project: { services: { edges: [] } } },
        });
      }
      if (request.query.includes("serviceCreate")) {
        serviceCreateCalls += 1;
        throw new Error("a second service create must never be issued");
      }
      throw new Error(`Unexpected GraphQL operation: ${request.query}`);
    }) as typeof fetch;

    await expect(
      provisionRailwayRuntime({
        assistant,
        stack: stack({ service_create_attempted_at: 100 }),
        runtimeActorSigningKey: "f".repeat(64),
        allowServiceCreation: true,
        config: config(),
        fetchImpl: secondFetch,
        sleep: async () => {},
        now: () => 200,
        persistence: makePersistence(),
      }),
    ).rejects.toThrow("operator reconciliation is required");

    expect(secondLookupCalls).toBe(4);
    expect(serviceCreateCalls).toBe(1);
  });

  test("never creates a second volume after an ambiguous response", async () => {
    let volumeLookupCalls = 0;
    let volumeCreateCalls = 0;
    const fetchImpl = (async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      if (request.query.includes("runtimeEnvironmentConfig")) {
        volumeLookupCalls += 1;
        return jsonResponse({
          data: {
            environment: {
              config: {
                services: {
                  "service-existing": { volumeMounts: {} },
                },
              },
            },
          },
        });
      }
      if (request.query.includes("variableCollectionUpsert")) {
        return jsonResponse({ data: { variableCollectionUpsert: true } });
      }
      if (request.query.includes("volumeCreate")) {
        volumeCreateCalls += 1;
        throw new Error("a second volume create must never be issued");
      }
      throw new Error(`Unexpected GraphQL operation: ${request.query}`);
    }) as typeof fetch;

    await expect(
      provisionRailwayRuntime({
        assistant,
        stack: stack({
          service_ref: "service-existing",
          volume_create_attempted_at: 100,
        }),
        runtimeActorSigningKey: "f".repeat(64),
        allowServiceCreation: false,
        config: config(),
        fetchImpl,
        sleep: async () => {},
        now: () => 200,
        persistence: makePersistence(),
      }),
    ).rejects.toThrow("operator reconciliation is required");

    expect(volumeLookupCalls).toBe(4);
    expect(volumeCreateCalls).toBe(0);
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
                      name: railwayRuntimeServiceName(assistant.id, "rt-1"),
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
      if (request.query.includes("serviceInstanceDeployV2")) {
        return jsonResponse({ data: { serviceInstanceDeployV2: "deploy-1" } });
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
      persistence: makePersistence({
        recordService: (id) => events.push(`service:${id}`),
        recordVolume: (id) => events.push(`volume:${id}`),
        markActive: (url, status) => events.push(`active:${url}:${status}`),
      }),
    });

    expect(serviceCreateCalls).toBe(0);
    expect(events).toEqual([
      "service:service-orphaned",
      "volume:volume-orphaned",
      `active:http://${railwayRuntimeServiceName(assistant.id, "rt-1")}.railway.internal:8080:200`,
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
        persistence: makePersistence(),
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
      if (request.query.includes("serviceInstanceDeployV2")) {
        return jsonResponse({ data: { serviceInstanceDeployV2: "deploy-1" } });
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
      persistence: makePersistence({
        recordService: () => {
          throw new Error("service should be reused");
        },
        recordVolume: () => {
          throw new Error("volume should be reused");
        },
        markActive: () => {},
      }),
    });

    expect(operations.some((query) => query.includes("serviceCreate"))).toBe(
      false,
    );
    expect(operations.some((query) => query.includes("volumeCreate"))).toBe(
      false,
    );
  });
});
