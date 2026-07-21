import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acceptArtifactInvitation,
  createArtifactInvitation,
  ensureArtifactSharingSchema,
} from "./artifact-sharing-store.js";
import { ensureAssistantRetirementSchema } from "./assistant-retirement-store.js";
import { ensureAssistantStoreSchema } from "./assistant-store.js";
import {
  createOrGetBrandResearchRun,
  ensureBrandResearchRunSchema,
} from "./brand-research-runs.js";
import {
  ensureRuntimeStackSchema,
  getRuntimeStackById,
  markRuntimeStackActive,
  recordRuntimeStackService,
  releaseRuntimeServiceProvisioningLease,
  type RuntimeStackRow,
} from "./runtime-stacks.js";
import {
  assignAssistant,
  ensureWorkspaceManagementSchema,
} from "./workspace-management-store.js";

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
  for (const server of servers.splice(0)) server.stop(true);
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
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function createTempDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "worklin-retirement-"));
  tempDirs.push(directory);
  return join(directory, "control-plane.sqlite");
}

function initializeDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      consent_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE assistants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  ensureArtifactSharingSchema(db);
  ensureAssistantStoreSchema(db);
  ensureRuntimeStackSchema(db);
  ensureBrandResearchRunSchema(db);
  ensureWorkspaceManagementSchema(db);
  ensureAssistantRetirementSchema(db);
  return db;
}

function seedUser(
  db: Database,
  userId: string,
  sessionId: string,
  consent = ACCEPTED_CONSENT,
): void {
  const timestamp = new Date().toISOString();
  db.query(
    `INSERT INTO users (
       id, email, username, first_name, last_name, consent_json, created_at,
       updated_at
     ) VALUES (?, ?, ?, '', '', ?, ?, ?)`,
  ).run(
    userId,
    `${userId}@example.com`,
    userId,
    consent,
    timestamp,
    timestamp,
  );
  db.query(
    "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  ).run(
    sessionId,
    userId,
    Math.floor(Date.now() / 1_000) + 3_600,
    timestamp,
  );
}

function seedOrganization(
  db: Database,
  orgId: string,
  ownerUserId: string,
): void {
  const timestamp = new Date().toISOString();
  db.query(
    `INSERT INTO organizations (
       id, user_id, name, is_default, created_at, updated_at
     ) VALUES (?, ?, 'Workspace', 1, ?, ?)`,
  ).run(orgId, ownerUserId, timestamp, timestamp);
  seedMembership(db, orgId, ownerUserId, "admin");
}

function seedMembership(
  db: Database,
  orgId: string,
  userId: string,
  role: "admin" | "manager" | "collaborator",
): void {
  const timestamp = new Date().toISOString();
  db.query(
    `INSERT INTO organization_memberships (
       org_id, user_id, role, status, created_at, updated_at
     ) VALUES (?, ?, ?, 'active', ?, ?)`,
  ).run(orgId, userId, role, timestamp, timestamp);
}

interface RuntimeSeed {
  status?: "provisioning" | "active" | "failed" | "suspended";
  provider?: string;
  gatewayUrl?: string | null;
  serviceRef?: string | null;
  volumeRef?: string | null;
  capacityReserved?: number;
  serviceCreateAttemptedAt?: number | null;
  volumeCreateAttemptedAt?: number | null;
  provisioningLeaseToken?: string | null;
  provisioningLeaseExpiresAt?: number | null;
}

function seedAssistant(
  db: Database,
  assistantId: string,
  ownerUserId: string,
  orgId: string,
  runtime: RuntimeSeed = {},
): string {
  const timestamp = new Date().toISOString();
  const stackId = `runtime-${assistantId}`;
  db.query(
    `INSERT INTO assistants (
       id, user_id, org_id, name, runtime_stack_id, isolation_version,
       admin_access_consented, is_default, created_at, updated_at
     ) VALUES (?, ?, ?, 'Worklin', ?, 2, 0, 1, ?, ?)`,
  ).run(assistantId, ownerUserId, orgId, stackId, timestamp, timestamp);
  db.query(
    `INSERT INTO runtime_stacks (
       id, org_id, assistant_id, status, provider, gateway_url,
       public_ingress_url, workspace_volume_ref, service_ref,
       service_capacity_reserved, service_create_attempted_at,
       volume_create_attempted_at, provisioning_lease_token,
       provisioning_lease_expires_at, actor_signing_key_scope,
       last_health_status, last_error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'https://worklin.example.com', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    stackId,
    orgId,
    assistantId,
    runtime.status ?? "active",
    runtime.provider ?? "railway",
    runtime.gatewayUrl === undefined
      ? "http://runtime.railway.internal:8080"
      : runtime.gatewayUrl,
    runtime.volumeRef ?? null,
    runtime.serviceRef ?? null,
    runtime.capacityReserved ?? 0,
    runtime.serviceCreateAttemptedAt ?? null,
    runtime.volumeCreateAttemptedAt ?? null,
    runtime.provisioningLeaseToken ?? null,
    runtime.provisioningLeaseExpiresAt ?? null,
    `runtime_v1:${stackId}`,
    runtime.status === "active" || runtime.status === undefined ? "200" : null,
    timestamp,
    timestamp,
  );
  return stackId;
}

function seedAssistantScopedRows(
  db: Database,
  assistantId: string,
  orgId: string,
  ownerUserId: string,
): void {
  assignAssistant(db, orgId, assistantId, ownerUserId, () => new Date().toISOString());
  const invitation = createArtifactInvitation(db, {
    assistant_id: assistantId,
    artifact_id: "artifact-1",
    email_normalized: "recipient@example.com",
    role: "viewer",
    token_hash: "artifact-token-hash",
    expires_at: 2_000_000_000,
    created_by_user_id: ownerUserId,
    created_at: new Date().toISOString(),
  });
  acceptArtifactInvitation(
    db,
    invitation,
    "recipient-user",
    new Date().toISOString(),
  );
  createOrGetBrandResearchRun(
    db,
    {
      orgId,
      userId: ownerUserId,
      assistantId,
      brandName: "Example Brand",
    },
    () => new Date().toISOString(),
  );
}

interface RailwayRequest {
  query: string;
  variables: Record<string, unknown>;
  projectToken: string | null;
}

interface FakeRailway {
  endpoint: string;
  requests: RailwayRequest[];
  serviceIds: Set<string>;
  volumeIds: Set<string>;
  serviceDeleteFailures: number;
}

async function startFakeRailway(
  serviceIds: string[] = [],
  volumeIds: string[] = [],
): Promise<FakeRailway> {
  const port = await freePort();
  const state: FakeRailway = {
    endpoint: `http://127.0.0.1:${port}/graphql/v2`,
    requests: [],
    serviceIds: new Set(serviceIds),
    volumeIds: new Set(volumeIds),
    serviceDeleteFailures: 0,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const body = (await request.json()) as {
        query: string;
        variables: Record<string, unknown>;
      };
      state.requests.push({
        ...body,
        projectToken: request.headers.get("Project-Access-Token"),
      });
      if (body.query.includes("runtimeRetirementResources")) {
        return Response.json({
          data: {
            project: {
              services: {
                edges: [...state.serviceIds].map((id) => ({ node: { id } })),
              },
              volumes: {
                edges: [...state.volumeIds].map((id) => ({ node: { id } })),
              },
            },
          },
        });
      }
      if (body.query.includes("mutation volumeDelete")) {
        state.volumeIds.delete(String(body.variables.volumeId));
        return Response.json({ data: { volumeDelete: true } });
      }
      if (body.query.includes("mutation serviceDelete")) {
        if (state.serviceDeleteFailures > 0) {
          state.serviceDeleteFailures -= 1;
          return Response.json({
            errors: [{ message: "service cleanup failed" }],
          });
        }
        state.serviceIds.delete(String(body.variables.id));
        return Response.json({ data: { serviceDelete: true } });
      }
      return Response.json(
        { errors: [{ message: "Unexpected Railway operation" }] },
        { status: 400 },
      );
    },
  });
  servers.push(server);
  return state;
}

function spawnControlPlane(
  port: number,
  dbPath: string,
  railwayEndpoint: string,
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
      WORKLIN_RAILWAY_PROVISIONING_ENABLED: "true",
      WORKLIN_RAILWAY_API_ENDPOINT: railwayEndpoint,
      WORKLIN_RAILWAY_PROJECT_TOKEN: "project-token",
      WORKLIN_RAILWAY_PROJECT_ID: "project-1",
      WORKLIN_RAILWAY_ENVIRONMENT_ID: "environment-1",
      WORKLIN_RAILWAY_MAX_RUNTIME_SERVICES: "10",
      WORKLIN_RAILWAY_REQUEST_TIMEOUT_MS: "500",
      WORKLIN_RAILWAY_PROVISIONING_LEASE_TTL_MS: "2000",
      RAILWAY_SERVICE_ID: "control-plane-service",
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
      if ((await fetch(`${origin}/healthz`)).ok) return;
    } catch {
      // Process startup is still in progress.
    }
    await Bun.sleep(10);
  }
  throw new Error("Control plane did not become healthy.");
}

function authenticatedHeaders(
  sessionId: string,
  orgId: string,
  csrf = true,
): Record<string, string> {
  return {
    Cookie: `worklin_session=${sessionId}; csrftoken=csrf-token`,
    "Content-Type": "application/json",
    "Vellum-Organization-Id": orgId,
    ...(csrf ? { "X-CSRFToken": "csrf-token" } : {}),
  };
}

function countRows(db: Database, table: string): number {
  if (!/^[a-z_]+$/.test(table)) throw new Error("Invalid table name.");
  return (
    db
      .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
      .get()?.count ?? 0
  );
}

function mutationCount(railway: FakeRailway, name: string): number {
  return railway.requests.filter((request) => request.query.includes(name))
    .length;
}

describe("control-plane assistant retirement", () => {
  test("owner cleanup is exact, idempotent, transactional, and isolated from a fresh assistant", async () => {
    const dbPath = createTempDbPath();
    const db = initializeDb(dbPath);
    seedUser(db, "owner-user", "owner-session");
    seedOrganization(db, "org-owner", "owner-user");
    const oldStackId = seedAssistant(
      db,
      "assistant-owner",
      "owner-user",
      "org-owner",
      { serviceRef: "runtime-service", volumeRef: "runtime-volume" },
    );
    seedAssistantScopedRows(
      db,
      "assistant-owner",
      "org-owner",
      "owner-user",
    );
    db.close();

    const railway = await startFakeRailway(
      ["runtime-service", "control-plane-service"],
      ["runtime-volume"],
    );
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    spawnControlPlane(port, dbPath, railway.endpoint);
    await waitForHealth(origin);

    const response = await fetch(
      `${origin}/v1/assistants/assistant-owner/retire/`,
      {
        method: "DELETE",
        headers: authenticatedHeaders("owner-session", "org-owner"),
      },
    );
    expect(response.status).toBe(204);
    expect(
      railway.requests.map((request) =>
        request.query.includes("volumeDelete")
          ? "volumeDelete"
          : request.query.includes("serviceDelete")
            ? "serviceDelete"
            : "query",
      ),
    ).toEqual(["query", "volumeDelete", "query", "serviceDelete"]);
    expect(
      railway.requests.every(
        (request) => request.projectToken === "project-token",
      ),
    ).toBe(true);

    const after = new Database(dbPath);
    expect(countRows(after, "assistants")).toBe(0);
    for (const table of [
      "assistant_assignments",
      "artifact_invitations",
      "artifact_grants",
      "brand_research_runs",
      "assistant_retirements",
    ]) {
      expect(countRows(after, table)).toBe(0);
    }
    expect(getRuntimeStackById(after, oldStackId)).toMatchObject({
      status: "deleted",
      service_ref: "runtime-service",
      workspace_volume_ref: "runtime-volume",
      service_capacity_reserved: 0,
      gateway_url: null,
    });
    after.close();

    const repeated = await fetch(
      `${origin}/v1/assistants/assistant-owner/retire/`,
      {
        method: "DELETE",
        headers: authenticatedHeaders("owner-session", "org-owner"),
      },
    );
    expect(repeated.status).toBe(404);
    expect(mutationCount(railway, "volumeDelete")).toBe(1);
    expect(mutationCount(railway, "serviceDelete")).toBe(1);
    const afterRepeated = new Database(dbPath);
    expect(countRows(afterRepeated, "assistants")).toBe(0);
    afterRepeated.close();

    const listResponse = await fetch(`${origin}/v1/assistants/`, {
      headers: authenticatedHeaders("owner-session", "org-owner"),
    });
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as {
      results: Array<{ id: string; runtime_stack_id: string }>;
    };
    expect(list.results).toHaveLength(1);
    expect(list.results[0]?.id).not.toBe("assistant-owner");
    const freshDb = new Database(dbPath);
    expect(getRuntimeStackById(freshDb, list.results[0]!.runtime_stack_id)).toMatchObject({
      status: "provisioning",
      service_ref: null,
      workspace_volume_ref: null,
    });
    freshDb.close();

    const legacyRoute = await fetch(`${origin}/v1/assistants/retire/`, {
      method: "DELETE",
      headers: authenticatedHeaders("owner-session", "org-owner"),
    });
    expect(legacyRoute.status).toBe(204);
  });

  test("requires CSRF and owner or active workspace-admin authorization", async () => {
    const dbPath = createTempDbPath();
    const db = initializeDb(dbPath);
    seedUser(db, "owner-user", "owner-session");
    seedUser(db, "admin-user", "admin-session");
    seedUser(db, "manager-user", "manager-session");
    seedUser(db, "outsider-user", "outsider-session");
    seedOrganization(db, "org-owner", "owner-user");
    seedMembership(db, "org-owner", "admin-user", "admin");
    seedMembership(db, "org-owner", "manager-user", "manager");
    seedAssistant(db, "assistant-auth", "owner-user", "org-owner");
    db.close();

    const railway = await startFakeRailway();
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    spawnControlPlane(port, dbPath, railway.endpoint);
    await waitForHealth(origin);

    const missingCsrf = await fetch(
      `${origin}/v1/assistants/assistant-auth/retire/`,
      {
        method: "DELETE",
        headers: authenticatedHeaders("owner-session", "org-owner", false),
      },
    );
    expect(missingCsrf.status).toBe(403);

    const manager = await fetch(
      `${origin}/v1/assistants/assistant-auth/retire/`,
      {
        method: "DELETE",
        headers: authenticatedHeaders("manager-session", "org-owner"),
      },
    );
    expect(manager.status).toBe(403);
    expect(await manager.json()).toMatchObject({
      code: "assistant_retirement_forbidden",
    });

    const crossTenant = await fetch(
      `${origin}/v1/assistants/assistant-auth/retire/`,
      {
        method: "DELETE",
        headers: authenticatedHeaders("outsider-session", "org-owner"),
      },
    );
    expect([403, 404]).toContain(crossTenant.status);

    const beforeAdmin = new Database(dbPath);
    expect(getRuntimeStackById(beforeAdmin, "runtime-assistant-auth")?.status).toBe(
      "active",
    );
    beforeAdmin.close();
    expect(railway.requests).toHaveLength(0);

    const admin = await fetch(
      `${origin}/v1/assistants/assistant-auth/retire/`,
      {
        method: "DELETE",
        headers: authenticatedHeaders("admin-session", "org-owner"),
      },
    );
    expect(admin.status).toBe(204);
    const afterAdmin = new Database(dbPath);
    expect(countRows(afterAdmin, "assistants")).toBe(0);
    afterAdmin.close();
  });

  test("persists partial Railway cleanup and keeps capacity reserved until retry succeeds", async () => {
    const dbPath = createTempDbPath();
    const db = initializeDb(dbPath);
    seedUser(db, "owner-user", "owner-session");
    seedOrganization(db, "org-owner", "owner-user");
    const stackId = seedAssistant(
      db,
      "assistant-partial",
      "owner-user",
      "org-owner",
      { serviceRef: "runtime-service", volumeRef: "runtime-volume" },
    );
    db.close();

    const railway = await startFakeRailway(
      ["runtime-service"],
      ["runtime-volume"],
    );
    railway.serviceDeleteFailures = 1;
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    spawnControlPlane(port, dbPath, railway.endpoint);
    await waitForHealth(origin);

    const first = await fetch(
      `${origin}/v1/assistants/assistant-partial/retire/`,
      {
        method: "DELETE",
        headers: authenticatedHeaders("owner-session", "org-owner"),
      },
    );
    expect(first.status).toBe(502);
    expect(await first.json()).toMatchObject({
      code: "runtime_retirement_cleanup_failed",
      runtime_status: "suspended",
    });
    const partial = new Database(dbPath);
    expect(getRuntimeStackById(partial, stackId)).toMatchObject({
      status: "suspended",
      service_ref: "runtime-service",
      workspace_volume_ref: "runtime-volume",
    });
    expect(
      partial
        .query<
          { service_cleanup_confirmed: number; volume_cleanup_confirmed: number },
          []
        >(
          "SELECT service_cleanup_confirmed, volume_cleanup_confirmed FROM assistant_retirements",
        )
        .get(),
    ).toEqual({
      service_cleanup_confirmed: 0,
      volume_cleanup_confirmed: 1,
    });
    expect(
      partial
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM runtime_stacks WHERE status != 'deleted' AND service_ref IS NOT NULL",
        )
        .get()?.count,
    ).toBe(1);
    partial.close();

    const retry = await fetch(
      `${origin}/v1/assistants/assistant-partial/retire/`,
      {
        method: "DELETE",
        headers: authenticatedHeaders("owner-session", "org-owner"),
      },
    );
    expect(retry.status).toBe(204);
    expect(mutationCount(railway, "volumeDelete")).toBe(1);
    expect(mutationCount(railway, "serviceDelete")).toBe(2);
    const complete = new Database(dbPath);
    expect(getRuntimeStackById(complete, stackId)?.status).toBe("deleted");
    complete.close();
  });

  test("waits for an in-flight provisioner and cannot be marked active afterward", async () => {
    const dbPath = createTempDbPath();
    const db = initializeDb(dbPath);
    seedUser(db, "owner-user", "owner-session");
    seedOrganization(db, "org-owner", "owner-user");
    const stackId = seedAssistant(
      db,
      "assistant-race",
      "owner-user",
      "org-owner",
      {
        status: "provisioning",
        gatewayUrl: "http://stale-runtime.internal:8080",
        capacityReserved: 1,
        serviceCreateAttemptedAt: Date.now(),
        provisioningLeaseToken: "provisioning-lease",
        provisioningLeaseExpiresAt: Date.now() + 60_000,
      },
    );
    db.close();

    const railway = await startFakeRailway(["runtime-service"]);
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    spawnControlPlane(port, dbPath, railway.endpoint);
    await waitForHealth(origin);

    const settling = await fetch(
      `${origin}/v1/assistants/assistant-race/retire/`,
      {
        method: "DELETE",
        headers: authenticatedHeaders("owner-session", "org-owner"),
      },
    );
    expect(settling.status).toBe(409);
    expect(await settling.json()).toMatchObject({
      code: "runtime_provisioning_settling",
    });
    expect(railway.requests).toHaveLength(0);

    const raced = new Database(dbPath);
    expect(getRuntimeStackById(raced, stackId)).toMatchObject({
      status: "suspended",
      gateway_url: null,
      service_capacity_reserved: 1,
    });
    recordRuntimeStackService(
      raced,
      stackId,
      "runtime-service",
      () => new Date().toISOString(),
      "provisioning-lease",
    );
    expect(() =>
      markRuntimeStackActive(
        raced,
        stackId,
        "http://runtime.railway.internal:8080",
        "200",
        () => new Date().toISOString(),
        "provisioning-lease",
      ),
    ).toThrow("lease was lost");
    releaseRuntimeServiceProvisioningLease(
      raced,
      stackId,
      "provisioning-lease",
      () => new Date().toISOString(),
    );
    raced.close();

    const retry = await fetch(
      `${origin}/v1/assistants/assistant-race/retire/`,
      {
        method: "DELETE",
        headers: authenticatedHeaders("owner-session", "org-owner"),
      },
    );
    expect(retry.status).toBe(204);
    expect(mutationCount(railway, "serviceDelete")).toBe(1);
  });

  test("reconciles an absent volume without repeating its delete", async () => {
    const dbPath = createTempDbPath();
    const db = initializeDb(dbPath);
    seedUser(db, "owner-user", "owner-session");
    seedOrganization(db, "org-owner", "owner-user");
    seedAssistant(db, "assistant-missing", "owner-user", "org-owner", {
      serviceRef: "runtime-service",
      volumeRef: "missing-volume",
    });
    db.close();

    const railway = await startFakeRailway(["runtime-service"], []);
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    spawnControlPlane(port, dbPath, railway.endpoint);
    await waitForHealth(origin);

    const response = await fetch(
      `${origin}/v1/assistants/assistant-missing/retire/`,
      {
        method: "DELETE",
        headers: authenticatedHeaders("owner-session", "org-owner"),
      },
    );
    expect(response.status).toBe(204);
    expect(mutationCount(railway, "volumeDelete")).toBe(0);
    expect(mutationCount(railway, "serviceDelete")).toBe(1);
  });

  test("fails closed without deleting legacy shared infrastructure", async () => {
    const dbPath = createTempDbPath();
    const db = initializeDb(dbPath);
    seedUser(db, "owner-user", "owner-session");
    seedOrganization(db, "org-owner", "owner-user");
    const stackId = seedAssistant(
      db,
      "assistant-legacy",
      "owner-user",
      "org-owner",
      {
        provider: "legacy_shared",
        serviceRef: "legacy-shared-runtime",
        volumeRef: "/data/shared-runtime",
      },
    );
    db.close();

    const railway = await startFakeRailway([
      "legacy-shared-runtime",
      "control-plane-service",
    ]);
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    spawnControlPlane(port, dbPath, railway.endpoint, {
      WORKLIN_REQUIRE_ISOLATED_RUNTIME: "false",
      WORKLIN_ALLOW_LEGACY_SHARED_RUNTIME: "true",
      WORKLIN_LEGACY_SHARED_RUNTIME_ASSISTANT_IDS: "assistant-legacy",
    });
    await waitForHealth(origin);

    const response = await fetch(
      `${origin}/v1/assistants/assistant-legacy/retire/`,
      {
        method: "DELETE",
        headers: authenticatedHeaders("owner-session", "org-owner"),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "legacy_shared_retirement_blocked",
    });
    expect(railway.requests).toHaveLength(0);
    const after = new Database(dbPath);
    expect(countRows(after, "assistants")).toBe(1);
    expect(getRuntimeStackById(after, stackId)).toMatchObject({
      status: "suspended",
      gateway_url: null,
      service_ref: "legacy-shared-runtime",
      workspace_volume_ref: "/data/shared-runtime",
    });
    after.close();
  });

  test("deletes an exact preprovisioned slot but never offers it again", async () => {
    const dbPath = createTempDbPath();
    const db = initializeDb(dbPath);
    seedUser(db, "owner-user", "owner-session");
    seedOrganization(db, "org-owner", "owner-user");
    const oldStackId = seedAssistant(
      db,
      "assistant-preprovisioned",
      "owner-user",
      "org-owner",
      {
        provider: "preprovisioned",
        serviceRef: "reserved-service",
        volumeRef: "reserved-volume",
      },
    );
    db.close();

    const railway = await startFakeRailway(
      ["reserved-service"],
      ["reserved-volume"],
    );
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    spawnControlPlane(port, dbPath, railway.endpoint, {
      WORKLIN_PREPROVISIONED_RUNTIME_SLOTS: JSON.stringify([
        {
          serviceRef: "reserved-service",
          gatewayUrl: "http://reserved-service.railway.internal:8080",
          workspaceVolumeRef: "reserved-volume",
        },
      ]),
    });
    await waitForHealth(origin);

    const retired = await fetch(
      `${origin}/v1/assistants/assistant-preprovisioned/retire/`,
      {
        method: "DELETE",
        headers: authenticatedHeaders("owner-session", "org-owner"),
      },
    );
    expect(retired.status).toBe(204);

    const list = (await (
      await fetch(`${origin}/v1/assistants/`, {
        headers: authenticatedHeaders("owner-session", "org-owner"),
      })
    ).json()) as { results: Array<{ id: string; runtime_stack_id: string }> };
    expect(list.results).toHaveLength(1);
    const hatch = await fetch(`${origin}/v1/assistants/hatch/`, {
      method: "POST",
      headers: authenticatedHeaders("owner-session", "org-owner"),
    });
    expect(hatch.status).toBe(200);

    const after = new Database(dbPath);
    expect(getRuntimeStackById(after, oldStackId)).toMatchObject({
      status: "deleted",
      service_ref: "reserved-service",
      workspace_volume_ref: "reserved-volume",
    });
    expect(getRuntimeStackById(after, list.results[0]!.runtime_stack_id)).toMatchObject({
      provider: "railway",
      status: "provisioning",
      service_ref: null,
      workspace_volume_ref: null,
    });
    after.close();
  });
});
