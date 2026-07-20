import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureAssistantStoreSchema } from "./assistant-store.js";
import { railwayRuntimeServiceName } from "./railway-runtime-provisioner.js";
import {
  deriveRuntimeActorSigningKey,
  ensureRuntimeStackSchema,
  type RuntimeStackRow,
} from "./runtime-stacks.js";

const CONTROL_PLANE_DIR = fileURLToPath(new URL("..", import.meta.url));
const CUSTOMER_COUNT = 5;
const PROVISIONING_CONCURRENCY = 2;
const SESSION_SECRET = "s".repeat(32);
const ACTOR_SIGNING_KEY = "a".repeat(64);
const ACCEPTED_CONSENT = JSON.stringify({
  tos_accepted_version: "2026-06-08",
  privacy_policy_accepted_version: "2026-06-08",
  ai_data_sharing_accepted_version: "2026-06-08",
});

interface CustomerFixture {
  index: number;
  userId: string;
  sessionId: string;
  assistantId: string;
}

interface RuntimeRequest {
  authorization: string;
  assistantId: string;
  orgId: string;
  userId: string;
  pathname: string;
  search: string;
}

interface RailwayOperation {
  query: string;
  variables: Record<string, unknown>;
}

const children: Bun.Subprocess[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to allocate a test port.");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function createTempDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "worklin-five-user-"));
  tempDirs.push(directory);
  return join(directory, "control-plane.sqlite");
}

function createControlPlaneSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      consent_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assistants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      runtime_stack_id TEXT,
      isolation_version INTEGER NOT NULL DEFAULT 2,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  ensureAssistantStoreSchema(db);
  ensureRuntimeStackSchema(db);
}

function seedConsentedCustomers(db: Database): void {
  const timestamp = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + 3_600;
  const insertUser = db.query(
    `INSERT INTO users (
      id, email, username, first_name, last_name, consent_json, created_at,
      updated_at
    ) VALUES (?, ?, ?, '', '', ?, ?, ?)`,
  );
  const insertSession = db.query(
    "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  );

  for (let index = 0; index < CUSTOMER_COUNT; index += 1) {
    const number = String(index + 1).padStart(2, "0");
    const userId = `user-customer-${number}`;
    insertUser.run(
      userId,
      `customer-${number}@example.com`,
      `customer-${number}`,
      ACCEPTED_CONSENT,
      timestamp,
      timestamp,
    );
    insertSession.run(
      `session-customer-${number}`,
      userId,
      expiresAt,
      timestamp,
    );
  }
}

function authenticatedHeaders(
  sessionId: string,
  authorization?: string,
): Record<string, string> {
  return {
    Cookie: `worklin_session=${sessionId}; csrftoken=csrf-token`,
    "Content-Type": "application/json",
    "X-CSRFToken": "csrf-token",
    ...(authorization ? { Authorization: authorization } : {}),
  };
}

function spawnControlPlane(
  port: number,
  dbPath: string,
  railwayApiEndpoint: string,
): Bun.Subprocess {
  const origin = `http://127.0.0.1:${port}`;
  const child = Bun.spawn({
    cmd: [process.execPath, "run", "src/index.ts"],
    cwd: CONTROL_PLANE_DIR,
    env: {
      ...process.env,
      WORKLIN_CONTROL_PLANE_PORT: String(port),
      WORKLIN_CONTROL_PLANE_HOST: "127.0.0.1",
      WORKLIN_CONTROL_DB: dbPath,
      WORKLIN_SESSION_SECRET: SESSION_SECRET,
      ACTOR_TOKEN_SIGNING_KEY: ACTOR_SIGNING_KEY,
      WORKLIN_WEB_ORIGIN: origin,
      WORKLIN_API_ORIGIN: origin,
      WORKLIN_GATEWAY_URL: "http://127.0.0.1:1",
      WORKLIN_REQUIRE_ISOLATED_RUNTIME: "true",
      WORKLIN_ALLOW_LEGACY_SHARED_RUNTIME: "false",
      WORKLIN_RAILWAY_PROVISIONING_ENABLED: "true",
      WORKLIN_RAILWAY_API_ENDPOINT: railwayApiEndpoint,
      WORKLIN_RAILWAY_PROJECT_TOKEN: "project-token",
      WORKLIN_RAILWAY_PROJECT_ID: "project-1",
      WORKLIN_RAILWAY_ENVIRONMENT_ID: "environment-1",
      WORKLIN_RAILWAY_MAX_RUNTIME_SERVICES: String(CUSTOMER_COUNT),
      WORKLIN_RAILWAY_PROVISIONING_CONCURRENCY: String(
        PROVISIONING_CONCURRENCY,
      ),
      WORKLIN_RAILWAY_POLL_INTERVAL_MS: "1",
      WORKLIN_RAILWAY_DEPLOY_TIMEOUT_MS: "1000",
      WORKLIN_RAILWAY_HEALTH_TIMEOUT_MS: "20",
      AUTH0_ISSUER_BASE_URL: "",
      AUTH0_CLIENT_ID: "",
      AUTH0_CLIENT_SECRET: "",
      AUTH0_SECRET: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  return child;
}

async function waitForHealth(origin: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
    } catch {
      // Process startup is still in progress.
    }
    await Bun.sleep(10);
  }
  throw new Error("Control plane did not become healthy.");
}

async function waitForProvisioningToSettle(
  dbPath: string,
): Promise<RuntimeStackRow[]> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const db = new Database(dbPath, { readonly: true });
    const stacks = db
      .query<
        RuntimeStackRow,
        []
      >("SELECT * FROM runtime_stacks ORDER BY assistant_id")
      .all();
    db.close();
    if (
      stacks.length === CUSTOMER_COUNT &&
      stacks.every(
        (stack) =>
          stack.status === "failed" &&
          stack.service_ref !== null &&
          stack.workspace_volume_ref !== null,
      )
    ) {
      return stacks;
    }
    await Bun.sleep(10);
  }
  throw new Error("Ten runtime provisioning jobs did not settle.");
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("Expected a three-part actor token.");
  }
  return JSON.parse(
    Buffer.from(parts[1], "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

function expectSignedWithRuntimeKey(token: string, runtimeKey: string): void {
  const [header, payload, signature] = token.split(".");
  expect(header).toBeTruthy();
  expect(payload).toBeTruthy();
  expect(signature).toBeTruthy();
  const signingInput = `${header}.${payload}`;
  expect(signature).toBe(
    createHmac("sha256", Buffer.from(runtimeKey, "hex"))
      .update(signingInput)
      .digest("base64url"),
  );
  expect(signature).not.toBe(
    createHmac("sha256", Buffer.from(ACTOR_SIGNING_KEY, "hex"))
      .update(signingInput)
      .digest("base64url"),
  );
}

describe("five-customer isolated runtime launch", () => {
  test("provisions and routes five customers without sharing identity, capacity, or authorization", async () => {
    const dbPath = createTempDbPath();
    const seedDb = new Database(dbPath);
    createControlPlaneSchema(seedDb);
    seedConsentedCustomers(seedDb);
    seedDb.close();

    const railwayOperations: RailwayOperation[] = [];
    const serviceCreateCounts = new Map<string, number>();
    const variablesByService = new Map<string, Record<string, string>>();
    let activeServiceCreates = 0;
    let maxActiveServiceCreates = 0;

    const railway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const operation = (await request.json()) as RailwayOperation;
        railwayOperations.push(operation);
        const input = operation.variables.input as
          | Record<string, unknown>
          | undefined;

        if (operation.query.includes("runtimeProjectServices")) {
          return Response.json({
            data: { project: { services: { edges: [] } } },
          });
        }
        if (operation.query.includes("serviceCreate")) {
          const serviceName = String(input?.name);
          activeServiceCreates += 1;
          maxActiveServiceCreates = Math.max(
            maxActiveServiceCreates,
            activeServiceCreates,
          );
          serviceCreateCounts.set(
            serviceName,
            (serviceCreateCounts.get(serviceName) ?? 0) + 1,
          );
          await Bun.sleep(25);
          activeServiceCreates -= 1;
          return Response.json({
            data: { serviceCreate: { id: `service-${serviceName}` } },
          });
        }
        if (operation.query.includes("runtimeEnvironmentConfig")) {
          return Response.json({
            data: { environment: { config: { services: {} } } },
          });
        }
        if (operation.query.includes("volumeCreate")) {
          const serviceId = String(input?.serviceId);
          return Response.json({
            data: { volumeCreate: { id: `volume-${serviceId}` } },
          });
        }
        if (operation.query.includes("variableCollectionUpsert")) {
          const serviceId = String(input?.serviceId);
          variablesByService.set(
            serviceId,
            (input?.variables ?? {}) as Record<string, string>,
          );
          return Response.json({
            data: { variableCollectionUpsert: true },
          });
        }
        if (operation.query.includes("serviceInstanceDeploy")) {
          return Response.json({
            data: {
              serviceInstanceDeploy: `deploy-${String(
                operation.variables.serviceId,
              )}`,
            },
          });
        }
        if (operation.query.includes("query deployment")) {
          return Response.json({
            data: { deployment: { status: "SUCCESS" } },
          });
        }
        return Response.json({
          errors: [{ message: "Unexpected Railway operation" }],
        });
      },
    });
    servers.push(railway);

    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    spawnControlPlane(port, dbPath, `http://127.0.0.1:${railway.port}`);
    await waitForHealth(origin);

    const hatchResponses = await Promise.all(
      Array.from({ length: CUSTOMER_COUNT }, async (_, index) => {
        const number = String(index + 1).padStart(2, "0");
        const response = await fetch(`${origin}/v1/assistants/hatch/`, {
          method: "POST",
          headers: authenticatedHeaders(`session-customer-${number}`),
          body: "{}",
        });
        return {
          index,
          response,
          payload: (await response.json()) as {
            id?: string;
            runtime_status?: string;
            runtime_stack_id?: string;
          },
        };
      }),
    );

    for (const { response, payload } of hatchResponses) {
      expect(response.status).toBe(201);
      expect(payload.id).toBeTruthy();
      expect(payload.runtime_status).toBe("provisioning");
      expect(payload.runtime_stack_id).toBeTruthy();
    }

    const customers: CustomerFixture[] = hatchResponses.map(
      ({ index, payload }) => {
        const number = String(index + 1).padStart(2, "0");
        return {
          index,
          userId: `user-customer-${number}`,
          sessionId: `session-customer-${number}`,
          assistantId: payload.id!,
        };
      },
    );
    expect(
      new Set(customers.map((customer) => customer.assistantId)).size,
    ).toBe(CUSTOMER_COUNT);

    // Hatch only prepares the assistant. The first real assistant request is
    // what claims capacity and starts each isolated runtime.
    const preparingResponses = await Promise.all(
      customers.map((customer) =>
        fetch(
          `${origin}/v1/assistants/${customer.assistantId}/conversations/`,
          { headers: authenticatedHeaders(customer.sessionId) },
        ),
      ),
    );
    for (const response of preparingResponses) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "runtime_not_ready",
      });
    }

    const settledStacks = await waitForProvisioningToSettle(dbPath);
    expect(maxActiveServiceCreates).toBe(PROVISIONING_CONCURRENCY);
    expect(maxActiveServiceCreates).toBeLessThanOrEqual(
      PROVISIONING_CONCURRENCY,
    );
    expect(serviceCreateCounts.size).toBe(CUSTOMER_COUNT);
    expect([...serviceCreateCounts.values()]).toEqual(
      Array(CUSTOMER_COUNT).fill(1),
    );

    const stackByAssistant = new Map(
      settledStacks.map((stack) => [stack.assistant_id, stack]),
    );
    expect(stackByAssistant.size).toBe(CUSTOMER_COUNT);
    expect(new Set(settledStacks.map((stack) => stack.service_ref)).size).toBe(
      CUSTOMER_COUNT,
    );
    expect(
      new Set(settledStacks.map((stack) => stack.workspace_volume_ref)).size,
    ).toBe(CUSTOMER_COUNT);
    expect(
      new Set(settledStacks.map((stack) => stack.actor_signing_key_scope)).size,
    ).toBe(CUSTOMER_COUNT);

    const runtimeSigningKeys = new Set<string>();
    for (const customer of customers) {
      const stack = stackByAssistant.get(customer.assistantId);
      expect(stack).toBeTruthy();
      expect(stack!.actor_signing_key_scope).toBe(`runtime_v1:${stack!.id}`);
      const runtimeSigningKey = deriveRuntimeActorSigningKey(
        ACTOR_SIGNING_KEY,
        stack!.actor_signing_key_scope,
      );
      runtimeSigningKeys.add(runtimeSigningKey);
      expect(runtimeSigningKey).not.toBe(ACTOR_SIGNING_KEY);

      const expectedServiceName = railwayRuntimeServiceName(
        customer.assistantId,
      );
      const expectedServiceId = `service-${expectedServiceName}`;
      expect(stack!.service_ref).toBe(expectedServiceId);
      expect(variablesByService.get(expectedServiceId)).toMatchObject({
        WORKLIN_RUNTIME_MODE: "isolated",
        WORKLIN_REQUIRE_ISOLATED_RUNTIME: "true",
        WORKLIN_ALLOW_LEGACY_SHARED_RUNTIME: "false",
        WORKLIN_PLATFORM_ASSISTANT_ID: customer.assistantId,
        RUNTIME_ASSISTANT_SCOPE_MODE: "enforce",
        ACTOR_TOKEN_SIGNING_KEY: runtimeSigningKey,
      });
    }
    expect(runtimeSigningKeys.size).toBe(CUSTOMER_COUNT);

    const runtimeRequests: RuntimeRequest[][] = Array.from(
      { length: CUSTOMER_COUNT },
      () => [],
    );
    const runtimeUrls = customers.map((customer) => {
      const runtime = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          runtimeRequests[customer.index]!.push({
            authorization: request.headers.get("authorization") ?? "",
            assistantId: request.headers.get("x-worklin-assistant-id") ?? "",
            orgId: request.headers.get("x-worklin-org-id") ?? "",
            userId: request.headers.get("x-worklin-user-id") ?? "",
            pathname: url.pathname,
            search: url.search,
          });
          return Response.json({
            runtimeCustomerIndex: customer.index,
            assistantId: customer.assistantId,
          });
        },
      });
      servers.push(runtime);
      return `http://127.0.0.1:${runtime.port}`;
    });

    const routeDb = new Database(dbPath);
    const setActiveRoute = routeDb.query(
      `UPDATE runtime_stacks
         SET status = 'active',
             gateway_url = ?,
             last_health_status = '200',
             last_error = NULL
         WHERE assistant_id = ?`,
    );
    for (const customer of customers) {
      setActiveRoute.run(runtimeUrls[customer.index], customer.assistantId);
    }
    routeDb.close();

    const ownRouteResponses = await Promise.all(
      customers.map(async (customer) => {
        const forgedAuthorization = `Bearer forged-customer-${customer.index}`;
        const response = await fetch(
          `${origin}/v1/assistants/${customer.assistantId}/conversations/?customer=${customer.index}`,
          {
            headers: authenticatedHeaders(
              customer.sessionId,
              forgedAuthorization,
            ),
          },
        );
        return {
          customer,
          forgedAuthorization,
          response,
          payload: (await response.json()) as {
            runtimeCustomerIndex?: number;
            assistantId?: string;
          },
        };
      }),
    );

    const forwardedAuthorizations = new Set<string>();
    for (const {
      customer,
      forgedAuthorization,
      response,
      payload,
    } of ownRouteResponses) {
      expect(response.status).toBe(200);
      expect(payload).toEqual({
        runtimeCustomerIndex: customer.index,
        assistantId: customer.assistantId,
      });
      expect(runtimeRequests[customer.index]).toHaveLength(1);
      const forwarded = runtimeRequests[customer.index]![0]!;
      expect(forwarded.authorization).toStartWith("Bearer ");
      expect(forwarded.authorization).not.toBe(forgedAuthorization);
      expect(forwarded.assistantId).toBe(customer.assistantId);
      const stack = stackByAssistant.get(customer.assistantId)!;
      expect(forwarded.orgId).toBe(stack.org_id);
      expect(forwarded.userId).toBe(customer.userId);
      expect(forwarded.pathname).toBe(
        `/v1/assistants/${customer.assistantId}/conversations/`,
      );
      expect(forwarded.search).toBe(`?customer=${customer.index}`);

      const token = forwarded.authorization.slice("Bearer ".length);
      const runtimeSigningKey = deriveRuntimeActorSigningKey(
        ACTOR_SIGNING_KEY,
        stack.actor_signing_key_scope,
      );
      expectSignedWithRuntimeKey(token, runtimeSigningKey);
      expect(decodeJwtPayload(token).sub).toStartWith(
        `actor:${customer.assistantId}:`,
      );
      expect(decodeJwtPayload(token).tenant_context).toMatchObject({
        version: 1,
        organization_id: stack.org_id,
        user_id: customer.userId,
        assistant_id: customer.assistantId,
        actor_id: `vellum-principal-${customer.userId}`,
      });
      forwardedAuthorizations.add(forwarded.authorization);
    }
    expect(forwardedAuthorizations.size).toBe(CUSTOMER_COUNT);

    const crossUserResponses = await Promise.all(
      customers.map(async (customer, index) => {
        const other = customers[(index + 1) % CUSTOMER_COUNT]!;
        return fetch(
          `${origin}/v1/assistants/${other.assistantId}/conversations/`,
          {
            headers: authenticatedHeaders(
              customer.sessionId,
              `Bearer forged-cross-user-${index}`,
            ),
          },
        );
      }),
    );
    for (const response of crossUserResponses) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        detail: "Assistant not found.",
      });
    }
    for (const requests of runtimeRequests) {
      expect(requests).toHaveLength(1);
    }

    expect(
      railwayOperations.filter((operation) =>
        operation.query.includes("serviceCreate"),
      ),
    ).toHaveLength(CUSTOMER_COUNT);
  }, 30_000);
});
