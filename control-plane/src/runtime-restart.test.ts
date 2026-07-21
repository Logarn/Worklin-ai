import { describe, expect, test } from "bun:test";

import { railwayProvisionerConfigFromEnv } from "./railway-runtime-provisioner.js";
import { requestRailwayRuntimeRestart } from "./runtime-restart.js";

function config() {
  return railwayProvisionerConfigFromEnv({
    WORKLIN_RAILWAY_PROVISIONING_ENABLED: "true",
    WORKLIN_RAILWAY_API_ENDPOINT: "https://railway.example/graphql",
    WORKLIN_RAILWAY_PROJECT_TOKEN: "project-token",
    WORKLIN_RAILWAY_PROJECT_ID: "project-1",
    WORKLIN_RAILWAY_ENVIRONMENT_ID: "environment-1",
    WORKLIN_RAILWAY_MAX_RUNTIME_SERVICES: "5",
  });
}

describe("requestRailwayRuntimeRestart", () => {
  test("restarts the latest active deployment without deploying or redeploying", async () => {
    const capturedRequests: Array<{
      url: string;
      token: string | null;
      query: string;
      variables: Record<string, unknown>;
    }> = [];
    const fetchImpl = (async (input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      capturedRequests.push({
        url: String(input),
        token: new Headers(init?.headers).get("Project-Access-Token"),
        ...body,
      });
      if (body.query.includes("query latestActiveDeployment")) {
        return Response.json({
          data: {
            deployments: {
              edges: [{ node: { id: "deployment-1", status: "SUCCESS" } }],
            },
          },
        });
      }
      if (body.query.includes("mutation deploymentRestart")) {
        return Response.json({ data: { deploymentRestart: true } });
      }
      return Response.json(
        { errors: [{ message: "Unexpected Railway operation" }] },
        { status: 400 },
      );
    }) as typeof fetch;

    const deploymentId = await requestRailwayRuntimeRestart({
      serviceId: "service-1",
      config: config(),
      fetchImpl,
    });

    expect(deploymentId).toBe("deployment-1");
    expect(capturedRequests).toHaveLength(2);
    expect(capturedRequests[0]).toMatchObject({
      url: "https://railway.example/graphql",
      token: "project-token",
      variables: {
        input: {
          projectId: "project-1",
          environmentId: "environment-1",
          serviceId: "service-1",
          status: { successfulOnly: true },
        },
      },
    });
    expect(capturedRequests[1]).toMatchObject({
      variables: { id: "deployment-1" },
    });
    expect(capturedRequests[1]?.query).toContain("deploymentRestart");
    for (const request of capturedRequests) {
      expect(request.query).not.toContain("serviceInstanceDeploy");
      expect(request.query).not.toContain("deploymentRedeploy");
    }
  });

  test("does not mutate when Railway has no active successful deployment", async () => {
    let requestCount = 0;
    const fetchImpl = (async () => {
      requestCount += 1;
      return Response.json({
        data: { deployments: { edges: [] } },
      });
    }) as unknown as typeof fetch;

    await expect(
      requestRailwayRuntimeRestart({
        serviceId: "service-1",
        config: config(),
        fetchImpl,
      }),
    ).rejects.toThrow("no active successful deployment");
    expect(requestCount).toBe(1);
  });

  test("rejects a Railway restart error instead of reporting success", async () => {
    const fetchImpl = (async (_input, _init) =>
      String(_init?.body).includes("latestActiveDeployment")
        ? Response.json({
            data: {
              deployments: {
                edges: [{ node: { id: "deployment-1", status: "SUCCESS" } }],
              },
            },
          })
        : Response.json({
            errors: [{ message: "restart rejected" }],
          })) as typeof fetch;

    await expect(
      requestRailwayRuntimeRestart({
        serviceId: "service-1",
        config: config(),
        fetchImpl,
      }),
    ).rejects.toThrow("restart rejected");
  });
});
