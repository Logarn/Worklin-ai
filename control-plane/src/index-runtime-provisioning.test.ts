import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensureAssistantStoreSchema,
  type AssistantRow,
} from "./assistant-store.js";
import {
  deriveRuntimeActorSigningKey,
  ensureRuntimeStackSchema,
  type RuntimeStackRow,
} from "./runtime-stacks.js";
import { ensureWorkspaceManagementSchema } from "./workspace-management-store.js";

const CONTROL_PLANE_DIR = fileURLToPath(new URL("..", import.meta.url));
const SESSION_SECRET = "s".repeat(32);
const ACTOR_SIGNING_KEY = "a".repeat(64);
const ACCEPTED_CONSENT = JSON.stringify({
  tos_accepted_version: "2026-06-08",
  privacy_policy_accepted_version: "2026-06-08",
  ai_data_sharing_accepted_version: "2026-06-08",
});

const children: Bun.Subprocess[] = [];
const tempDirs: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
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
  const directory = mkdtempSync(join(tmpdir(), "worklin-control-plane-"));
  tempDirs.push(directory);
  return join(directory, "control-plane.sqlite");
}

function spawnControlPlane(
  port: number,
  dbPath: string,
  overrides: Record<string, string> = {},
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
      AUTH0_ISSUER_BASE_URL: "",
      AUTH0_CLIENT_ID: "",
      AUTH0_CLIENT_SECRET: "",
      AUTH0_SECRET: "",
      WORKLIN_RAILWAY_PROVISIONING_ENABLED: "false",
      ...overrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  return child;
}

async function waitForHealth(origin: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
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
  ensureWorkspaceManagementSchema(db);
}

function authenticatedHeaders(sessionId: string): Record<string, string> {
  return {
    Cookie: `worklin_session=${sessionId}; csrftoken=csrf-token`,
    "Content-Type": "application/json",
    "X-CSRFToken": "csrf-token",
  };
}

function seedAuthenticatedUser(
  dbPath: string,
  {
    userId,
    sessionId,
  }: {
    userId: string;
    sessionId: string;
  },
): void {
  const db = new Database(dbPath);
  createControlPlaneSchema(db);
  const timestamp = new Date().toISOString();
  db.query(
    `INSERT INTO users (
      id, email, username, first_name, last_name, consent_json, created_at,
      updated_at
    ) VALUES (?, ?, ?, '', '', NULL, ?, ?)`,
  ).run(userId, `${userId}@example.com`, userId, timestamp, timestamp);
  db.query(
    "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  ).run(sessionId, userId, Math.floor(Date.now() / 1000) + 3_600, timestamp);
  db.close();
}

describe("control-plane billing capability", () => {
  test("advertises external-provider billing without balances or paid status", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const dbPath = createTempDbPath();
    seedAuthenticatedUser(dbPath, {
      userId: "user-billing-capability",
      sessionId: "session-billing-capability",
    });

    spawnControlPlane(port, dbPath);
    await waitForHealth(origin);

    const unauthenticatedResponse = await fetch(
      `${origin}/v1/organizations/billing/capability/`,
    );
    expect(unauthenticatedResponse.status).toBe(401);

    const response = await fetch(
      `${origin}/v1/organizations/billing/capability/`,
      { headers: authenticatedHeaders("session-billing-capability") },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      available: false,
      mode: "external_provider",
      reason: "managed_billing_not_configured",
    });
    expect(body).not.toHaveProperty("settled_balance");
    expect(body).not.toHaveProperty("plan");
    expect(body).not.toHaveProperty("subscription");
  });

  test("legacy billing routes fail closed and retain CSRF protection", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const dbPath = createTempDbPath();
    seedAuthenticatedUser(dbPath, {
      userId: "user-billing-routes",
      sessionId: "session-billing-routes",
    });

    spawnControlPlane(port, dbPath);
    await waitForHealth(origin);

    const summaryResponse = await fetch(
      `${origin}/v1/organizations/billing/summary/`,
      { headers: authenticatedHeaders("session-billing-routes") },
    );
    expect(summaryResponse.status).toBe(501);
    expect(await summaryResponse.json()).toEqual({
      error: {
        code: "billing_unavailable",
        message: "Worklin credit billing is not available in this deployment.",
      },
    });

    const missingCsrfResponse = await fetch(
      `${origin}/v1/organizations/billing/top-ups/checkout-session/`,
      {
        method: "POST",
        headers: {
          Cookie: "worklin_session=session-billing-routes",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    expect(missingCsrfResponse.status).toBe(403);

    const unavailableMutationResponse = await fetch(
      `${origin}/v1/organizations/billing/top-ups/checkout-session/`,
      {
        method: "POST",
        headers: authenticatedHeaders("session-billing-routes"),
        body: "{}",
      },
    );
    expect(unavailableMutationResponse.status).toBe(501);
    expect(await unavailableMutationResponse.json()).toEqual({
      error: {
        code: "billing_unavailable",
        message: "Worklin credit billing is not available in this deployment.",
      },
    });
  });
});

describe("control-plane runtime provisioning guards", () => {
  test("control-plane-only readiness does not depend on a shared gateway", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const dbPath = createTempDbPath();

    spawnControlPlane(port, dbPath, {
      WORKLIN_RUNTIME_MODE: "control-plane",
      WORKLIN_RAILWAY_PROVISIONING_ENABLED: "true",
      WORKLIN_RAILWAY_PROJECT_TOKEN: "project-token",
      WORKLIN_RAILWAY_PROJECT_ID: "project-1",
      WORKLIN_RAILWAY_ENVIRONMENT_ID: "production-1",
      WORKLIN_RAILWAY_MAX_RUNTIME_SERVICES: "5",
      WORKLIN_REQUIRE_ISOLATED_RUNTIME: "true",
      WORKLIN_ALLOW_LEGACY_SHARED_RUNTIME: "false",
    });
    await waitForHealth(origin);

    const response = await fetch(`${origin}/readyz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      gatewayStatus: null,
      runtimeMode: "control-plane",
      provisionerReady: true,
    });
  });

  test("control-plane-only readiness rejects the shared-runtime fallback", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const dbPath = createTempDbPath();

    spawnControlPlane(port, dbPath, {
      WORKLIN_RUNTIME_MODE: "control-plane",
      WORKLIN_RAILWAY_PROVISIONING_ENABLED: "true",
      WORKLIN_RAILWAY_PROJECT_TOKEN: "project-token",
      WORKLIN_RAILWAY_PROJECT_ID: "project-1",
      WORKLIN_RAILWAY_ENVIRONMENT_ID: "production-1",
      WORKLIN_RAILWAY_MAX_RUNTIME_SERVICES: "5",
      WORKLIN_REQUIRE_ISOLATED_RUNTIME: "true",
      WORKLIN_ALLOW_LEGACY_SHARED_RUNTIME: "true",
    });
    await waitForHealth(origin);

    const response = await fetch(`${origin}/readyz`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      gatewayStatus: null,
      runtimeMode: "control-plane",
      provisionerReady: false,
    });
  });

  test("the upstream logout route always invalidates the Worklin session", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const dbPath = createTempDbPath();
    const db = new Database(dbPath);
    createControlPlaneSchema(db);
    const timestamp = new Date().toISOString();
    db.query(
      `INSERT INTO users (
        id, email, username, first_name, last_name, consent_json, created_at,
        updated_at
      ) VALUES (?, ?, ?, '', '', NULL, ?, ?)`,
    ).run("user-logout", "logout@example.com", "logout", timestamp, timestamp);
    db.query(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      "session-logout",
      "user-logout",
      Math.floor(Date.now() / 1000) + 3_600,
      timestamp,
    );
    db.close();

    spawnControlPlane(port, dbPath);
    await waitForHealth(origin);

    const response = await fetch(`${origin}/logout`, {
      headers: { Cookie: "worklin_session=session-logout" },
      redirect: "manual",
    });
    expect(response.headers.get("set-cookie")).toContain("worklin_session=");

    const verificationDb = new Database(dbPath);
    expect(
      verificationDb
        .query<{ id: string }, []>(
          "SELECT id FROM sessions WHERE id = 'session-logout'",
        )
        .get(),
    ).toBeNull();
    verificationDb.close();
  });

  test("logout still clears the browser and continues when session deletion fails", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const dbPath = createTempDbPath();
    const db = new Database(dbPath);
    createControlPlaneSchema(db);
    const timestamp = new Date().toISOString();
    db.query(
      `INSERT INTO users (
        id, email, username, first_name, last_name, consent_json, created_at,
        updated_at
      ) VALUES (?, ?, ?, '', '', NULL, ?, ?)`,
    ).run(
      "user-logout-failure",
      "logout-failure@example.com",
      "logout-failure",
      timestamp,
      timestamp,
    );
    db.query(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      "session-logout-failure",
      "user-logout-failure",
      Math.floor(Date.now() / 1000) + 3_600,
      timestamp,
    );
    db.exec(`
      CREATE TRIGGER fail_session_delete
      BEFORE DELETE ON sessions
      BEGIN
        SELECT RAISE(FAIL, 'simulated session cleanup failure');
      END;
    `);
    db.close();

    spawnControlPlane(port, dbPath);
    await waitForHealth(origin);

    const response = await fetch(`${origin}/logout`, {
      headers: { Cookie: "worklin_session=session-logout-failure" },
      redirect: "manual",
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toContain("worklin_session=");

    const verificationDb = new Database(dbPath);
    expect(
      verificationDb
        .query<{ id: string }, []>(
          "SELECT id FROM sessions WHERE id = 'session-logout-failure'",
        )
        .get(),
    ).not.toBeNull();
    verificationDb.close();
  });

  test("hatch requires consent and runtime proxying remains fail-closed", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const dbPath = createTempDbPath();
    spawnControlPlane(port, dbPath, {
      WORKLIN_REQUIRE_ISOLATED_RUNTIME: "false",
      WORKLIN_ALLOW_LEGACY_SHARED_RUNTIME: "true",
      WORKLIN_LEGACY_SHARED_RUNTIME_ASSISTANT_IDS: "asst-existing-customer",
    });
    await waitForHealth(origin);

    const db = new Database(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    const timestamp = new Date().toISOString();
    db.query(
      `INSERT INTO users (
        id, email, username, first_name, last_name, consent_json, created_at,
        updated_at
      ) VALUES (?, ?, ?, '', '', NULL, ?, ?)`,
    ).run("user-1", "user1@example.com", "user1", timestamp, timestamp);
    db.query(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      "session-1",
      "user-1",
      Math.floor(Date.now() / 1000) + 3_600,
      timestamp,
    );

    const blocked = await fetch(`${origin}/v1/assistants/hatch/`, {
      method: "POST",
      headers: authenticatedHeaders("session-1"),
      body: "{}",
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({
      code: "assistant_consent_required",
    });
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM runtime_stacks",
        )
        .get()?.count,
    ).toBe(0);

    db.query("UPDATE users SET consent_json = ? WHERE id = ?").run(
      ACCEPTED_CONSENT,
      "user-1",
    );
    const unavailable = await fetch(`${origin}/v1/assistants/hatch/`, {
      method: "POST",
      headers: authenticatedHeaders("session-1"),
      body: "{}",
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      code: "platform_hosted_disabled",
      runtime_status: "provisioning",
    });

    const assistant = db
      .query<AssistantRow, []>("SELECT * FROM assistants LIMIT 1")
      .get();
    expect(assistant).not.toBeNull();
    const proxyResponse = await fetch(
      `${origin}/v1/assistants/${assistant!.id}/conversations/`,
      {
        headers: {
          ...authenticatedHeaders("session-1"),
          Authorization: "Bearer client-supplied-token",
        },
      },
    );
    expect(proxyResponse.status).toBe(503);
    expect(await proxyResponse.json()).toMatchObject({
      code: "runtime_not_ready",
      runtime_status: "failed",
    });
    db.close();
  });

  test("provisioning retry recovers a failed runtime without overloading restart", async () => {
    let railwayRequestCount = 0;
    const railway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        railwayRequestCount += 1;
        await Bun.sleep(1_000);
        return Response.json({ errors: [{ message: "test stop" }] });
      },
    });
    servers.push(railway);

    const dbPath = createTempDbPath();
    const db = new Database(dbPath);
    createControlPlaneSchema(db);
    const timestamp = new Date().toISOString();
    db.query(
      `INSERT INTO users (
        id, email, username, first_name, last_name, consent_json, created_at,
        updated_at
      ) VALUES (?, ?, ?, '', '', ?, ?, ?)`,
    ).run(
      "user-retry",
      "retry@example.com",
      "retry",
      ACCEPTED_CONSENT,
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO organizations (
        id, user_id, name, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)`,
    ).run("org-retry", "user-retry", "Retry", timestamp, timestamp);
    db.query(
      `INSERT INTO assistants (
        id, user_id, org_id, name, runtime_stack_id, isolation_version,
        is_default, created_at, updated_at
      ) VALUES (?, ?, ?, 'Worklin', ?, 2, 1, ?, ?)`,
    ).run(
      "asst-retry",
      "user-retry",
      "org-retry",
      "rt-retry",
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO assistants (
        id, user_id, org_id, name, runtime_stack_id, isolation_version,
        is_default, created_at, updated_at
      ) VALUES (?, ?, ?, 'Worklin', ?, 2, 0, ?, ?)`,
    ).run(
      "asst-non-retryable",
      "user-retry",
      "org-retry",
      "rt-non-retryable",
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO runtime_stacks (
        id, org_id, assistant_id, status, provider, gateway_url,
        public_ingress_url, workspace_volume_ref, service_ref,
        actor_signing_key_scope, last_health_status, last_error, created_at,
        updated_at
      ) VALUES (?, ?, ?, 'failed', 'railway', NULL, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(
      "rt-retry",
      "org-retry",
      "asst-retry",
      "https://worklin.example.com",
      "volume-retry",
      "service-retry",
      "runtime_v1:rt-retry",
      "Previous deployment failed.",
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO runtime_stacks (
        id, org_id, assistant_id, status, provider, gateway_url,
        public_ingress_url, workspace_volume_ref, service_ref,
        actor_signing_key_scope, last_health_status, last_error, created_at,
        updated_at
      ) VALUES (?, ?, ?, 'failed', 'preprovisioned', NULL, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(
      "rt-non-retryable",
      "org-retry",
      "asst-non-retryable",
      "https://worklin.example.com",
      "volume-non-retryable",
      "service-non-retryable",
      "global",
      "Unsupported runtime failure.",
      timestamp,
      timestamp,
    );
    db.query(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      "session-retry",
      "user-retry",
      Math.floor(Date.now() / 1000) + 3_600,
      timestamp,
    );
    db.close();

    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    spawnControlPlane(port, dbPath, {
      WORKLIN_RAILWAY_PROVISIONING_ENABLED: "true",
      WORKLIN_RAILWAY_API_ENDPOINT: `http://127.0.0.1:${railway.port}`,
      WORKLIN_RAILWAY_PROJECT_TOKEN: "project-token",
      WORKLIN_RAILWAY_PROJECT_ID: "project-1",
      WORKLIN_RAILWAY_ENVIRONMENT_ID: "environment-1",
      WORKLIN_RAILWAY_MAX_RUNTIME_SERVICES: "5",
      WORKLIN_RAILWAY_PROVISIONING_CONCURRENCY: "1",
    });
    await waitForHealth(origin);

    const restart = await fetch(`${origin}/v1/assistants/asst-retry/restart/`, {
      method: "POST",
      headers: authenticatedHeaders("session-retry"),
      body: "{}",
    });
    expect(restart.status).toBe(501);
    expect(await restart.json()).toEqual({
      capability: "restart",
      supported: false,
      code: "runtime_capability_unavailable",
      detail: "Managed restart is not available for this assistant.",
    });
    expect(railwayRequestCount).toBe(0);

    const response = await fetch(
      `${origin}/v1/assistants/asst-retry/provisioning/retry/`,
      {
        method: "POST",
        headers: authenticatedHeaders("session-retry"),
        body: "{}",
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      detail: "Assistant runtime preparation requested.",
      code: "runtime_provisioning",
      runtime_status: "provisioning",
      runtime_stack_id: "rt-retry",
    });

    const unsupported = await fetch(
      `${origin}/v1/assistants/asst-non-retryable/provisioning/retry/`,
      {
        method: "POST",
        headers: authenticatedHeaders("session-retry"),
        body: "{}",
      },
    );
    expect(unsupported.status).toBe(503);
    expect(await unsupported.json()).toEqual({
      detail: "This assistant runtime cannot be prepared automatically.",
      code: "runtime_not_retryable",
      runtime_status: "failed",
      runtime_stack_id: "rt-non-retryable",
    });
  });

  test("runtime actions are explicit, scoped, and restart the active deployment", async () => {
    const railwayOperations: Array<{
      query: string;
      variables: Record<string, unknown>;
    }> = [];
    const runtimeGatewayRequests: string[] = [];
    const runtimeGateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        runtimeGatewayRequests.push(
          `${request.method} ${new URL(request.url).pathname}`,
        );
        return Response.json(
          { detail: "A guarded runtime action reached the runtime gateway." },
          { status: 599 },
        );
      },
    });
    servers.push(runtimeGateway);
    const railway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const operation = (await request.json()) as {
          query: string;
          variables: Record<string, unknown>;
        };
        railwayOperations.push(operation);
        if (operation.query.includes("query latestActiveDeployment")) {
          return Response.json({
            data: {
              deployments: {
                edges: [
                  {
                    node: {
                      id: "deployment-restart-1",
                      status: "SUCCESS",
                    },
                  },
                ],
              },
            },
          });
        }
        if (operation.query.includes("mutation deploymentRestart")) {
          return Response.json({ data: { deploymentRestart: true } });
        }
        return Response.json(
          { errors: [{ message: "Unexpected Railway operation" }] },
          { status: 400 },
        );
      },
    });
    servers.push(railway);

    const dbPath = createTempDbPath();
    const db = new Database(dbPath);
    createControlPlaneSchema(db);
    const timestamp = new Date().toISOString();
    db.query(
      `INSERT INTO users (
        id, email, username, first_name, last_name, consent_json, created_at,
        updated_at
      ) VALUES
        ('user-restart-owner', 'restart-owner@example.com', 'restart-owner', '', '', ?, ?, ?),
        ('user-restart-admin', 'restart-admin@example.com', 'restart-admin', '', '', ?, ?, ?),
        ('user-restart-manager', 'restart-manager@example.com', 'restart-manager', '', '', ?, ?, ?),
        ('user-restart-collaborator', 'restart-collaborator@example.com', 'restart-collaborator', '', '', ?, ?, ?)`,
    ).run(
      ACCEPTED_CONSENT,
      timestamp,
      timestamp,
      ACCEPTED_CONSENT,
      timestamp,
      timestamp,
      ACCEPTED_CONSENT,
      timestamp,
      timestamp,
      ACCEPTED_CONSENT,
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO users (
        id, email, username, first_name, last_name, consent_json, created_at,
        updated_at
      ) VALUES (?, ?, ?, '', '', '', ?, ?)`,
    ).run(
      "user-restart-unconsented",
      "restart-unconsented@example.com",
      "restart-unconsented",
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO organizations (
        id, user_id, name, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)`,
    ).run(
      "org-restart-collaboration",
      "user-restart-owner",
      "Restart collaboration",
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO organization_memberships (
        org_id, user_id, role, status, created_at, updated_at
      ) VALUES
        (?, ?, 'admin', 'active', ?, ?),
        (?, ?, 'admin', 'active', ?, ?),
        (?, ?, 'manager', 'active', ?, ?),
        (?, ?, 'collaborator', 'active', ?, ?)`,
    ).run(
      "org-restart-collaboration",
      "user-restart-owner",
      timestamp,
      timestamp,
      "org-restart-collaboration",
      "user-restart-admin",
      timestamp,
      timestamp,
      "org-restart-collaboration",
      "user-restart-manager",
      timestamp,
      timestamp,
      "org-restart-collaboration",
      "user-restart-collaborator",
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO organization_memberships (
        org_id, user_id, role, status, created_at, updated_at
      ) VALUES (?, ?, 'admin', 'active', ?, ?)`,
    ).run(
      "org-restart-collaboration",
      "user-restart-unconsented",
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO assistants (
        id, user_id, org_id, name, runtime_stack_id, isolation_version,
        is_default, created_at, updated_at
      ) VALUES (?, ?, ?, 'Worklin', ?, 2, 1, ?, ?)`,
    ).run(
      "asst-restart-collaboration",
      "user-restart-owner",
      "org-restart-collaboration",
      "rt-restart-collaboration",
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO assistant_assignments (
        org_id, assistant_id, user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "org-restart-collaboration",
      "asst-restart-collaboration",
      "user-restart-collaborator",
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO runtime_stacks (
        id, org_id, assistant_id, status, provider, gateway_url,
        public_ingress_url, workspace_volume_ref, service_ref,
        actor_signing_key_scope, last_health_status, last_error, created_at,
        updated_at
      ) VALUES (?, ?, ?, 'active', 'railway', ?, ?, ?, ?, ?, '200', NULL, ?, ?)`,
    ).run(
      "rt-restart-collaboration",
      "org-restart-collaboration",
      "asst-restart-collaboration",
      `http://127.0.0.1:${runtimeGateway.port}`,
      "https://worklin.example.com",
      "volume-restart-collaboration",
      "service-restart-collaboration",
      "runtime_v1:rt-restart-collaboration",
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES
        (?, ?, ?, ?),
        (?, ?, ?, ?),
        (?, ?, ?, ?),
        (?, ?, ?, ?)`,
    ).run(
      "session-restart-owner",
      "user-restart-owner",
      Math.floor(Date.now() / 1000) + 3_600,
      timestamp,
      "session-restart-admin",
      "user-restart-admin",
      Math.floor(Date.now() / 1000) + 3_600,
      timestamp,
      "session-restart-manager",
      "user-restart-manager",
      Math.floor(Date.now() / 1000) + 3_600,
      timestamp,
      "session-restart-collaborator",
      "user-restart-collaborator",
      Math.floor(Date.now() / 1000) + 3_600,
      timestamp,
    );
    db.query(
      `INSERT INTO sessions (id, user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(
      "session-restart-unconsented",
      "user-restart-unconsented",
      Math.floor(Date.now() / 1000) + 3_600,
      timestamp,
    );
    db.close();

    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    spawnControlPlane(port, dbPath, {
      WORKLIN_RAILWAY_PROVISIONING_ENABLED: "true",
      WORKLIN_RAILWAY_API_ENDPOINT: `http://127.0.0.1:${railway.port}`,
      WORKLIN_RAILWAY_PROJECT_TOKEN: "project-token",
      WORKLIN_RAILWAY_PROJECT_ID: "project-1",
      WORKLIN_RAILWAY_ENVIRONMENT_ID: "environment-1",
      WORKLIN_RAILWAY_MAX_RUNTIME_SERVICES: "5",
    });
    await waitForHealth(origin);

    const assistantResponse = await fetch(
      `${origin}/v1/assistants/asst-restart-collaboration/`,
      { headers: authenticatedHeaders("session-restart-collaborator") },
    );
    expect(assistantResponse.status).toBe(200);
    expect(await assistantResponse.json()).toMatchObject({
      runtime_action_capabilities: {
        restart: {
          capability: "restart",
          supported: false,
          code: "runtime_capability_unavailable",
          detail:
            "Only the assistant owner or a workspace admin can restart it.",
        },
        terminal: {
          capability: "terminal",
          supported: false,
          code: "runtime_capability_unavailable",
        },
        doctor: {
          capability: "doctor",
          supported: false,
          code: "runtime_capability_unavailable",
        },
        update_window: {
          capability: "update_window",
          supported: false,
          code: "runtime_capability_unavailable",
        },
      },
    });

    const adminAssistantResponse = await fetch(
      `${origin}/v1/assistants/asst-restart-collaboration/`,
      { headers: authenticatedHeaders("session-restart-admin") },
    );
    expect(adminAssistantResponse.status).toBe(200);
    expect(await adminAssistantResponse.json()).toMatchObject({
      runtime_action_capabilities: {
        restart: {
          capability: "restart",
          supported: true,
          code: "supported",
        },
      },
    });

    const managerAssistantResponse = await fetch(
      `${origin}/v1/assistants/asst-restart-collaboration/`,
      { headers: authenticatedHeaders("session-restart-manager") },
    );
    expect(managerAssistantResponse.status).toBe(200);
    expect(await managerAssistantResponse.json()).toMatchObject({
      runtime_action_capabilities: {
        restart: {
          capability: "restart",
          supported: false,
          code: "runtime_capability_unavailable",
          detail:
            "Only the assistant owner or a workspace admin can restart it.",
        },
      },
    });

    const wrongMethod = await fetch(
      `${origin}/v1/assistants/asst-restart-collaboration/restart/`,
      { headers: authenticatedHeaders("session-restart-owner") },
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("Allow")).toBe("POST");
    expect(await wrongMethod.json()).toEqual({
      detail: "Method not allowed.",
      code: "method_not_allowed",
    });
    expect(railwayOperations).toHaveLength(0);

    const encodedRestartMissingCsrf = await fetch(
      `${origin}/v1/assistants/asst-restart-collaboration/re%73tart/`,
      {
        method: "POST",
        headers: {
          Cookie: "worklin_session=session-restart-owner; csrftoken=csrf-token",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    expect(encodedRestartMissingCsrf.status).toBe(403);
    expect(await encodedRestartMissingCsrf.json()).toEqual({
      detail: "CSRF validation failed.",
    });

    const encodedRestartForbidden = await fetch(
      `${origin}/v1/assistants/asst-restart-collaboration/re%73tart/`,
      {
        method: "POST",
        headers: authenticatedHeaders("session-restart-manager"),
        body: "{}",
      },
    );
    expect(encodedRestartForbidden.status).toBe(403);
    expect(await encodedRestartForbidden.json()).toEqual({
      detail: "Only the assistant owner or a workspace admin can restart it.",
      code: "runtime_restart_forbidden",
    });

    const encodedRestartWithoutConsent = await fetch(
      `${origin}/v1/assistants/asst-restart-collaboration/re%73tart/`,
      {
        method: "POST",
        headers: authenticatedHeaders("session-restart-unconsented"),
        body: "{}",
      },
    );
    expect(encodedRestartWithoutConsent.status).toBe(403);
    expect(await encodedRestartWithoutConsent.json()).toEqual({
      detail: "Assistant consent must be accepted before use.",
    });
    expect(railwayOperations).toHaveLength(0);
    expect(runtimeGatewayRequests).toEqual([]);

    const forbiddenManagerRestart = await fetch(
      `${origin}/v1/assistants/asst-restart-collaboration/restart/`,
      {
        method: "POST",
        headers: authenticatedHeaders("session-restart-manager"),
        body: "{}",
      },
    );
    expect(forbiddenManagerRestart.status).toBe(403);
    expect(await forbiddenManagerRestart.json()).toEqual({
      detail: "Only the assistant owner or a workspace admin can restart it.",
      code: "runtime_restart_forbidden",
    });
    expect(railwayOperations).toHaveLength(0);

    const restartMissingCsrf = await fetch(
      `${origin}/v1/assistants/asst-restart-collaboration/restart/`,
      {
        method: "POST",
        headers: {
          Cookie: "worklin_session=session-restart-owner; csrftoken=csrf-token",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    expect(restartMissingCsrf.status).toBe(403);
    expect(await restartMissingCsrf.json()).toEqual({
      detail: "CSRF validation failed.",
    });
    expect(railwayOperations).toHaveLength(0);

    const forbiddenRestart = await fetch(
      `${origin}/v1/assistants/asst-restart-collaboration/restart/`,
      {
        method: "POST",
        headers: authenticatedHeaders("session-restart-collaborator"),
        body: "{}",
      },
    );
    expect(forbiddenRestart.status).toBe(403);
    expect(await forbiddenRestart.json()).toEqual({
      detail: "Only the assistant owner or a workspace admin can restart it.",
      code: "runtime_restart_forbidden",
    });
    expect(railwayOperations).toHaveLength(0);

    const response = await fetch(
      `${origin}/v1/assistants/asst-restart-collaboration/restart/`,
      {
        method: "POST",
        headers: authenticatedHeaders("session-restart-admin"),
        body: "{}",
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      detail: "Assistant runtime restart requested.",
      code: "runtime_restart_requested",
      runtime_status: "active",
      runtime_stack_id: "rt-restart-collaboration",
    });
    expect(railwayOperations).toHaveLength(2);
    expect(railwayOperations[0]?.variables).toEqual({
      input: {
        projectId: "project-1",
        environmentId: "environment-1",
        serviceId: "service-restart-collaboration",
        status: { successfulOnly: true },
      },
    });
    expect(railwayOperations[1]?.variables).toEqual({
      id: "deployment-restart-1",
    });
    expect(
      railwayOperations.some((operation) =>
        operation.query.includes("serviceInstanceDeploy"),
      ),
    ).toBe(false);
    expect(
      railwayOperations.some((operation) =>
        operation.query.includes("deploymentRedeploy"),
      ),
    ).toBe(false);

    const missingCsrf = await fetch(
      `${origin}/v1/assistants/asst-restart-collaboration/terminal/sessions/`,
      {
        method: "POST",
        headers: {
          Cookie:
            "worklin_session=session-restart-collaborator; csrftoken=csrf-token",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    expect(missingCsrf.status).toBe(403);
    expect(await missingCsrf.json()).toEqual({
      detail: "CSRF validation failed.",
    });

    const terminal = await fetch(
      `${origin}/v1/assistants/asst-restart-collaboration/terminal/sessions/`,
      {
        method: "POST",
        headers: authenticatedHeaders("session-restart-collaborator"),
        body: "{}",
      },
    );
    expect(terminal.status).toBe(501);
    expect(await terminal.json()).toMatchObject({
      capability: "terminal",
      supported: false,
      code: "runtime_capability_unavailable",
    });

    const encodedTerminalMissingCsrf = await fetch(
      `${origin}/v1/assistants/asst-restart-collaboration/term%69nal/sessions/`,
      {
        method: "POST",
        headers: {
          Cookie:
            "worklin_session=session-restart-collaborator; csrftoken=csrf-token",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    expect(encodedTerminalMissingCsrf.status).toBe(403);
    expect(await encodedTerminalMissingCsrf.json()).toEqual({
      detail: "CSRF validation failed.",
    });

    const encodedTerminal = await fetch(
      `${origin}/v1/assistants/asst-restart-collaboration/term%69nal/sessions/`,
      {
        method: "POST",
        headers: authenticatedHeaders("session-restart-collaborator"),
        body: "{}",
      },
    );
    expect(encodedTerminal.status).toBe(501);
    expect(await encodedTerminal.json()).toMatchObject({
      capability: "terminal",
      supported: false,
      code: "runtime_capability_unavailable",
    });

    const doctor = await fetch(
      `${origin}/v1/assistants/asst-restart-collaboration/doctor/sessions/`,
      {
        method: "POST",
        headers: authenticatedHeaders("session-restart-collaborator"),
        body: "{}",
      },
    );
    expect(doctor.status).toBe(501);
    expect(await doctor.json()).toMatchObject({
      capability: "doctor",
      supported: false,
      code: "runtime_capability_unavailable",
    });

    const encodedDoctor = await fetch(
      `${origin}/v1/assistants/asst-restart-collaboration/doct%6Fr/sessions/`,
      {
        method: "POST",
        headers: authenticatedHeaders("session-restart-collaborator"),
        body: "{}",
      },
    );
    expect(encodedDoctor.status).toBe(501);
    expect(await encodedDoctor.json()).toMatchObject({
      capability: "doctor",
      supported: false,
      code: "runtime_capability_unavailable",
    });

    const encodedDoctorWithoutConsent = await fetch(
      `${origin}/v1/assistants/asst-restart-collaboration/doct%6Fr/history/`,
      { headers: authenticatedHeaders("session-restart-unconsented") },
    );
    expect(encodedDoctorWithoutConsent.status).toBe(403);
    expect(await encodedDoctorWithoutConsent.json()).toEqual({
      detail: "Assistant consent must be accepted before use.",
    });

    const malformedActionPaths = [
      "terminal//sessions/",
      "terminal%2Fsessions/",
      "terminal%5Csessions/",
      "re%2573tart/",
      "%ZZ/",
    ];
    for (const actionPath of malformedActionPaths) {
      const malformed = await fetch(
        `${origin}/v1/assistants/asst-restart-collaboration/${actionPath}`,
        { headers: authenticatedHeaders("session-restart-collaborator") },
      );
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({
        detail: "The assistant request path is malformed or ambiguous.",
        code: "invalid_assistant_path",
      });
    }
    expect(runtimeGatewayRequests).toEqual([]);

    const updateWindow = await fetch(
      `${origin}/v1/assistants/asst-restart-collaboration/upgrade-policy/`,
      { headers: authenticatedHeaders("session-restart-collaborator") },
    );
    expect(updateWindow.status).toBe(501);
    expect(await updateWindow.json()).toMatchObject({
      capability: "update_window",
      supported: false,
      code: "runtime_capability_unavailable",
    });

    const inaccessible = await fetch(
      `${origin}/v1/assistants/asst-not-assigned/upgrade-policy/`,
      { headers: authenticatedHeaders("session-restart-collaborator") },
    );
    expect(inaccessible.status).toBe(404);
    expect(await inaccessible.json()).toEqual({
      detail: "Assistant not found.",
    });
  });

  test("an existing allowlisted legacy customer remains active", async () => {
    const dbPath = createTempDbPath();
    const db = new Database(dbPath);
    createControlPlaneSchema(db);
    const timestamp = new Date().toISOString();
    db.query(
      `INSERT INTO users (
        id, email, username, first_name, last_name, consent_json, created_at,
        updated_at
      ) VALUES (?, ?, ?, '', '', ?, ?, ?)`,
    ).run(
      "user-existing",
      "existing@example.com",
      "existing",
      ACCEPTED_CONSENT,
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO organizations (
        id, user_id, name, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)`,
    ).run("org-existing", "user-existing", "Existing", timestamp, timestamp);
    db.query(
      `INSERT INTO assistants (
        id, user_id, org_id, name, runtime_stack_id, isolation_version,
        is_default, created_at, updated_at
      ) VALUES (?, ?, ?, 'Worklin', NULL, 2, 1, ?, ?)`,
    ).run(
      "asst-existing-customer",
      "user-existing",
      "org-existing",
      timestamp,
      timestamp,
    );
    db.query(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      "session-existing",
      "user-existing",
      Math.floor(Date.now() / 1000) + 3_600,
      timestamp,
    );
    db.close();

    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    spawnControlPlane(port, dbPath, {
      WORKLIN_REQUIRE_ISOLATED_RUNTIME: "false",
      WORKLIN_ALLOW_LEGACY_SHARED_RUNTIME: "true",
      WORKLIN_LEGACY_SHARED_RUNTIME_ASSISTANT_IDS: "asst-existing-customer",
    });
    await waitForHealth(origin);

    const response = await fetch(`${origin}/v1/assistants/active/`, {
      headers: authenticatedHeaders("session-existing"),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "asst-existing-customer",
      status: "active",
      runtime_status: "active",
      runtime_provider: "legacy_shared",
    });
    const verificationDb = new Database(dbPath);
    expect(
      verificationDb
        .query<RuntimeStackRow, []>("SELECT * FROM runtime_stacks LIMIT 1")
        .get()?.actor_signing_key_scope,
    ).toBe("global");
    verificationDb.close();
  });

  test("runtime proxy replaces client auth with a stack-scoped token", async () => {
    let runtimeAuthorization = "";
    let runtimeTenantHeaders: Record<string, string> = {};
    const runtime = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        runtimeAuthorization = request.headers.get("authorization") ?? "";
        runtimeTenantHeaders = {
          version:
            request.headers.get("x-worklin-tenant-context-version") ?? "",
          organization: request.headers.get("x-worklin-org-id") ?? "",
          user: request.headers.get("x-worklin-user-id") ?? "",
          assistant: request.headers.get("x-worklin-assistant-id") ?? "",
          actor: request.headers.get("x-worklin-actor-id") ?? "",
          request: request.headers.get("x-worklin-request-id") ?? "",
        };
        return Response.json({ ok: true });
      },
    });
    servers.push(runtime);

    const dbPath = createTempDbPath();
    const db = new Database(dbPath);
    createControlPlaneSchema(db);
    const timestamp = new Date().toISOString();
    const signingScope = "runtime_v1:rt-token";
    db.query(
      `INSERT INTO users (
        id, email, username, first_name, last_name, consent_json, created_at,
        updated_at
      ) VALUES (?, ?, ?, '', '', ?, ?, ?)`,
    ).run(
      "user-token",
      "token@example.com",
      "token",
      ACCEPTED_CONSENT,
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO organizations (
        id, user_id, name, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)`,
    ).run("org-token", "user-token", "Token", timestamp, timestamp);
    db.query(
      `INSERT INTO assistants (
        id, user_id, org_id, name, runtime_stack_id, isolation_version,
        is_default, created_at, updated_at
      ) VALUES (?, ?, ?, 'Worklin', ?, 2, 1, ?, ?)`,
    ).run(
      "asst-token",
      "user-token",
      "org-token",
      "rt-token",
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO runtime_stacks (
        id, org_id, assistant_id, status, provider, gateway_url,
        public_ingress_url, workspace_volume_ref, service_ref,
        actor_signing_key_scope, last_health_status, last_error, created_at,
        updated_at
      ) VALUES (?, ?, ?, 'active', 'railway', ?, ?, ?, ?, ?, '200', NULL, ?, ?)`,
    ).run(
      "rt-token",
      "org-token",
      "asst-token",
      `http://127.0.0.1:${runtime.port}`,
      "https://worklin.example.com",
      "volume-token",
      "service-token",
      signingScope,
      timestamp,
      timestamp,
    );
    db.query(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      "session-token",
      "user-token",
      Math.floor(Date.now() / 1000) + 3_600,
      timestamp,
    );
    db.close();

    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    spawnControlPlane(port, dbPath);
    await waitForHealth(origin);

    const response = await fetch(
      `${origin}/v1/assistants/asst-token/conversations/`,
      {
        headers: {
          ...authenticatedHeaders("session-token"),
          Authorization: "Bearer client-supplied-token",
          "X-Worklin-Org-Id": "org-forged",
          "X-Worklin-User-Id": "user-forged",
          "X-Worklin-Assistant-Id": "asst-forged",
          "X-Worklin-Actor-Id": "actor-forged",
          "X-Worklin-Request-Id": "request-forged",
        },
      },
    );
    expect(response.status).toBe(200);
    expect(runtimeAuthorization).toStartWith("Bearer ");
    expect(runtimeAuthorization).not.toBe("Bearer client-supplied-token");

    const token = runtimeAuthorization.slice("Bearer ".length);
    const [header, payload, signature] = token.split(".");
    const signingInput = `${header}.${payload}`;
    const runtimeKey = deriveRuntimeActorSigningKey(
      ACTOR_SIGNING_KEY,
      signingScope,
    );
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
    const claims = JSON.parse(
      Buffer.from(payload!, "base64url").toString("utf8"),
    ) as {
      sub: string;
      tenant_context: Record<string, unknown>;
    };
    expect(claims.sub).toBe("actor:asst-token:vellum-principal-user-token");
    expect(claims.tenant_context).toEqual({
      version: 1,
      organization_id: "org-token",
      user_id: "user-token",
      assistant_id: "asst-token",
      actor_id: "vellum-principal-user-token",
      request_id: runtimeTenantHeaders.request,
    });
    expect(runtimeTenantHeaders).toEqual({
      version: "1",
      organization: "org-token",
      user: "user-token",
      assistant: "asst-token",
      actor: "vellum-principal-user-token",
      request: runtimeTenantHeaders.request,
    });
    expect(runtimeTenantHeaders.request).not.toBe("");
    expect(runtimeTenantHeaders.request).not.toBe("request-forged");
  });

  test("runtime proxy rejects an assistant whose organization belongs to another user", async () => {
    let runtimeRequests = 0;
    const runtime = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        runtimeRequests += 1;
        return Response.json({ ok: true });
      },
    });
    servers.push(runtime);

    const dbPath = createTempDbPath();
    const db = new Database(dbPath);
    createControlPlaneSchema(db);
    const timestamp = new Date().toISOString();
    db.query(
      `INSERT INTO users (
        id, email, username, first_name, last_name, consent_json, created_at,
        updated_at
      ) VALUES
        ('user-owner', 'owner@example.com', 'owner', '', '', ?, ?, ?),
        ('user-other', 'other@example.com', 'other', '', '', ?, ?, ?)`,
    ).run(
      ACCEPTED_CONSENT,
      timestamp,
      timestamp,
      ACCEPTED_CONSENT,
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO organizations (
        id, user_id, name, is_default, created_at, updated_at
      ) VALUES
        ('org-owner', 'user-owner', 'Owner', 1, ?, ?),
        ('org-other', 'user-other', 'Other', 1, ?, ?)`,
    ).run(timestamp, timestamp, timestamp, timestamp);
    db.query(
      `INSERT INTO assistants (
        id, user_id, org_id, name, runtime_stack_id, isolation_version,
        is_default, created_at, updated_at
      ) VALUES (?, ?, ?, 'Worklin', ?, 2, 1, ?, ?)`,
    ).run(
      "asst-cross-org",
      "user-owner",
      "org-other",
      "rt-cross-org",
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO runtime_stacks (
        id, org_id, assistant_id, status, provider, gateway_url,
        public_ingress_url, workspace_volume_ref, service_ref,
        actor_signing_key_scope, last_health_status, last_error, created_at,
        updated_at
      ) VALUES (?, ?, ?, 'active', 'railway', ?, ?, ?, ?, ?, '200', NULL, ?, ?)`,
    ).run(
      "rt-cross-org",
      "org-other",
      "asst-cross-org",
      `http://127.0.0.1:${runtime.port}`,
      "https://worklin.example.com",
      "volume-cross-org",
      "service-cross-org",
      "runtime_v1:rt-cross-org",
      timestamp,
      timestamp,
    );
    db.query(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      "session-owner",
      "user-owner",
      Math.floor(Date.now() / 1000) + 3_600,
      timestamp,
    );
    db.close();

    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    spawnControlPlane(port, dbPath);
    await waitForHealth(origin);

    const response = await fetch(
      `${origin}/v1/assistants/asst-cross-org/conversations/`,
      { headers: authenticatedHeaders("session-owner") },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: "Assistant not found." });
    expect(runtimeRequests).toBe(0);
  });

  test("runtime proxy rejects a stack whose organization was swapped", async () => {
    let runtimeRequests = 0;
    const runtime = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        runtimeRequests += 1;
        return Response.json({ ok: true });
      },
    });
    servers.push(runtime);

    const dbPath = createTempDbPath();
    const db = new Database(dbPath);
    createControlPlaneSchema(db);
    const timestamp = new Date().toISOString();
    db.query(
      `INSERT INTO users (
        id, email, username, first_name, last_name, consent_json, created_at,
        updated_at
      ) VALUES (?, ?, ?, '', '', ?, ?, ?)`,
    ).run(
      "user-stack-swap",
      "stack-swap@example.com",
      "stack-swap",
      ACCEPTED_CONSENT,
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO organizations (
        id, user_id, name, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)`,
    ).run("org-stack-owner", "user-stack-swap", "Owner", timestamp, timestamp);
    db.query(
      `INSERT INTO assistants (
        id, user_id, org_id, name, runtime_stack_id, isolation_version,
        is_default, created_at, updated_at
      ) VALUES (?, ?, ?, 'Worklin', ?, 2, 1, ?, ?)`,
    ).run(
      "asst-stack-swap",
      "user-stack-swap",
      "org-stack-owner",
      "rt-stack-swap",
      timestamp,
      timestamp,
    );
    db.query(
      `INSERT INTO runtime_stacks (
        id, org_id, assistant_id, status, provider, gateway_url,
        public_ingress_url, workspace_volume_ref, service_ref,
        actor_signing_key_scope, last_health_status, last_error, created_at,
        updated_at
      ) VALUES (?, ?, ?, 'active', 'railway', ?, ?, ?, ?, ?, '200', NULL, ?, ?)`,
    ).run(
      "rt-stack-swap",
      "org-swapped",
      "asst-stack-swap",
      `http://127.0.0.1:${runtime.port}`,
      "https://worklin.example.com",
      "volume-stack-swap",
      "service-stack-swap",
      "runtime_v1:rt-stack-swap",
      timestamp,
      timestamp,
    );
    db.query(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      "session-stack-swap",
      "user-stack-swap",
      Math.floor(Date.now() / 1000) + 3_600,
      timestamp,
    );
    db.close();

    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    spawnControlPlane(port, dbPath);
    await waitForHealth(origin);

    const response = await fetch(
      `${origin}/v1/assistants/asst-stack-swap/conversations/`,
      { headers: authenticatedHeaders("session-stack-swap") },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      detail: "Assistant runtime identity is unavailable.",
      code: "runtime_tenant_context_invalid",
    });
    expect(runtimeRequests).toBe(0);
  });

  test("startup does not provision assistants before their first real request", async () => {
    const dbPath = createTempDbPath();
    const db = new Database(dbPath);
    createControlPlaneSchema(db);
    const timestamp = new Date().toISOString();
    db.query(
      `INSERT INTO users (
        id, email, username, first_name, last_name, consent_json, created_at,
        updated_at
      ) VALUES
        ('user-accepted', 'accepted@example.com', 'accepted', '', '', ?, ?, ?),
        ('user-pending', 'pending@example.com', 'pending', '', '', NULL, ?, ?)`,
    ).run(ACCEPTED_CONSENT, timestamp, timestamp, timestamp, timestamp);
    db.query(
      `INSERT INTO organizations (
        id, user_id, name, is_default, created_at, updated_at
      ) VALUES
        ('org-accepted', 'user-accepted', 'Accepted', 1, ?, ?),
        ('org-pending', 'user-pending', 'Pending', 1, ?, ?)`,
    ).run(timestamp, timestamp, timestamp, timestamp);
    db.query(
      `INSERT INTO assistants (
        id, user_id, org_id, name, runtime_stack_id, isolation_version,
        is_default, created_at, updated_at
      ) VALUES
        ('asst-accepted', 'user-accepted', 'org-accepted', 'Worklin', NULL, 2, 1, ?, ?),
        ('asst-pending', 'user-pending', 'org-pending', 'Worklin', NULL, 2, 1, ?, ?)`,
    ).run(timestamp, timestamp, timestamp, timestamp);
    db.close();

    const railwayOperations: Array<{
      query: string;
      variables: Record<string, unknown>;
    }> = [];
    const railway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const payload = (await request.json()) as {
          query: string;
          variables: Record<string, unknown>;
        };
        railwayOperations.push(payload);
        if (payload.query.includes("runtimeProjectServices")) {
          return Response.json({
            data: { project: { services: { edges: [] } } },
          });
        }
        if (payload.query.includes("serviceCreate")) {
          return Response.json({
            data: { serviceCreate: { id: "service-accepted" } },
          });
        }
        if (payload.query.includes("runtimeEnvironmentConfig")) {
          return Response.json({
            data: { environment: { config: { services: {} } } },
          });
        }
        if (payload.query.includes("volumeCreate")) {
          return Response.json({
            data: { volumeCreate: { id: "volume-accepted" } },
          });
        }
        if (payload.query.includes("variableCollectionUpsert")) {
          return Response.json({
            data: { variableCollectionUpsert: true },
          });
        }
        if (payload.query.includes("serviceInstanceDeployV2")) {
          return Response.json({
            data: { serviceInstanceDeployV2: "deploy-accepted" },
          });
        }
        if (payload.query.includes("query deployment")) {
          return Response.json({
            data: { deployment: { status: "SUCCESS" } },
          });
        }
        return Response.json({ errors: [{ message: "Unexpected operation" }] });
      },
    });
    servers.push(railway);

    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    spawnControlPlane(port, dbPath, {
      WORKLIN_RAILWAY_PROVISIONING_ENABLED: "true",
      WORKLIN_RAILWAY_API_ENDPOINT: `http://127.0.0.1:${railway.port}`,
      WORKLIN_RAILWAY_PROJECT_TOKEN: "project-token",
      WORKLIN_RAILWAY_PROJECT_ID: "project-1",
      WORKLIN_RAILWAY_ENVIRONMENT_ID: "environment-1",
      WORKLIN_RAILWAY_MAX_RUNTIME_SERVICES: "10",
      WORKLIN_RAILWAY_PROVISIONING_CONCURRENCY: "2",
      WORKLIN_RAILWAY_POLL_INTERVAL_MS: "1",
      WORKLIN_RAILWAY_DEPLOY_TIMEOUT_MS: "100",
      WORKLIN_RAILWAY_HEALTH_TIMEOUT_MS: "20",
    });
    await waitForHealth(origin);

    await Bun.sleep(100);
    railway.stop(true);

    expect(
      railwayOperations.filter((operation) =>
        operation.query.includes("serviceCreate"),
      ),
    ).toHaveLength(0);
    const verificationDb = new Database(dbPath);
    expect(
      verificationDb
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM runtime_stacks",
        )
        .get()?.count,
    ).toBe(0);
    verificationDb.close();
  });
});
