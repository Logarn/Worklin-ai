import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveManagedOAuthServiceKey } from "./managed-google-oauth.js";
import {
  deriveRuntimeActorSigningKey,
  ensureRuntimeStackSchema,
} from "./runtime-stacks.js";

const CONTROL_PLANE_DIR = fileURLToPath(new URL("..", import.meta.url));
const SESSION_SECRET = "s".repeat(32);
const ACTOR_SIGNING_KEY = "a".repeat(64);
const children: Bun.Subprocess[] = [];
const databases: Database[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
  for (const db of databases.splice(0)) db.close();
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

function createSeededDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "worklin-google-oauth-route-"));
  tempDirs.push(directory);
  const dbPath = join(directory, "control-plane.sqlite");
  const db = new Database(dbPath);
  databases.push(db);
  const timestamp = "2026-07-29T00:00:00.000Z";
  const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      consent_json TEXT,
      onboarding_completed_at TEXT,
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
      runtime_stack_id TEXT,
      isolation_version INTEGER NOT NULL DEFAULT 2,
      admin_access_consented INTEGER NOT NULL DEFAULT 0,
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
  ensureRuntimeStackSchema(db);
  db.query(
    `INSERT INTO users (
       id, email, username, first_name, last_name, consent_json,
       onboarding_completed_at, created_at, updated_at
     ) VALUES ('user-1', 'user@example.com', 'Marketer', '', '', NULL, NULL, ?, ?)`,
  ).run(timestamp, timestamp);
  db.query(
    `INSERT INTO organizations (id, user_id, name, created_at, updated_at)
     VALUES ('organization-1', 'user-1', 'Workspace', ?, ?)`,
  ).run(timestamp, timestamp);
  db.query(
    `INSERT INTO assistants (
       id, user_id, org_id, name, runtime_stack_id, isolation_version,
       admin_access_consented, created_at, updated_at
     ) VALUES (
       'assistant-1', 'user-1', 'organization-1', 'Sunny Square',
       'stack-1', 2, 1, ?, ?
     )`,
  ).run(timestamp, timestamp);
  db.query(
    `INSERT INTO sessions (id, user_id, expires_at, created_at)
     VALUES ('session-1', 'user-1', ?, ?)`,
  ).run(expiresAt, timestamp);
  db.query(
    `INSERT INTO runtime_stacks (
       id, org_id, assistant_id, status, provider, gateway_url,
       public_ingress_url, workspace_volume_ref, service_ref,
       service_capacity_reserved, service_create_attempted_at,
       volume_create_attempted_at, provisioning_lease_token,
       provisioning_lease_expires_at, actor_signing_key_scope,
       last_health_status, last_error, created_at, updated_at
     ) VALUES (
       'stack-1', 'organization-1', 'assistant-1', 'active', 'railway',
       'http://runtime.internal:8080', 'https://worklin.example.test',
       'volume-1', 'service-1', 0, NULL, NULL, NULL, NULL,
       'runtime_v1:stack-1', '200', NULL, ?, ?
     )`,
  ).run(timestamp, timestamp);
  return dbPath;
}

function spawnControlPlane(
  port: number,
  dbPath: string,
): { child: Bun.Subprocess; origin: string } {
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
      WORKLIN_PUBLIC_PLATFORM_URL: origin,
      WORKLIN_API_ORIGIN: origin,
      WORKLIN_GATEWAY_URL: "http://127.0.0.1:1",
      WORKLIN_GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
      WORKLIN_GOOGLE_OAUTH_CLIENT_CREDENTIAL: "google-client-credential",
      WORKLIN_OAUTH_TOKEN_ENCRYPTION_KEY: "b".repeat(64),
      AUTH0_ISSUER_BASE_URL: "",
      AUTH0_CLIENT_ID: "",
      AUTH0_CLIENT_SECRET: "",
      AUTH0_SECRET: "",
      WORKLIN_RAILWAY_PROVISIONING_ENABLED: "false",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  return { child, origin };
}

async function waitForHealth(origin: string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
    } catch {
      // The child is still starting.
    }
    await Bun.sleep(20);
  }
  throw new Error("Control plane did not become healthy.");
}

describe("managed Google OAuth routes", () => {
  test("serves browser start/list and runtime list without gateway fallback", async () => {
    const dbPath = createSeededDatabase();
    const port = await freePort();
    const { origin } = spawnControlPlane(port, dbPath);
    await waitForHealth(origin);

    const browserHeaders = {
      Cookie: "worklin_session=session-1; csrftoken=csrf-1",
      "X-CSRFToken": "csrf-1",
      "Content-Type": "application/json",
    };
    const initial = await fetch(
      `${origin}/v1/assistants/assistant-1/oauth/connections`,
      { headers: browserHeaders },
    );
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual([]);

    const started = await fetch(
      `${origin}/v1/assistants/assistant-1/oauth/google/start`,
      {
        method: "POST",
        headers: browserHeaders,
        body: JSON.stringify({
          requested_scopes: [],
          redirect_after_connect: `${origin}/account/oauth/popup-complete?requestId=req-1&oauth_provider=google`,
        }),
      },
    );
    expect(started.status).toBe(200);
    const startBody = (await started.json()) as {
      connect_url: string;
      provider: string;
    };
    expect(startBody.provider).toBe("google");
    expect(new URL(startBody.connect_url).origin).toBe(
      "https://accounts.google.com",
    );

    const runtimeSigningKey = deriveRuntimeActorSigningKey(
      ACTOR_SIGNING_KEY,
      "runtime_v1:stack-1",
    );
    const runtimeServiceKey = deriveManagedOAuthServiceKey(
      runtimeSigningKey,
      "assistant-1",
    );
    const runtimeList = await fetch(
      `${origin}/v1/assistants/assistant-1/oauth/connections?provider=google&status=ACTIVE`,
      { headers: { Authorization: `Api-Key ${runtimeServiceKey}` } },
    );
    expect(runtimeList.status).toBe(200);
    expect(await runtimeList.json()).toEqual([]);

    const rejected = await fetch(
      `${origin}/v1/assistants/assistant-1/oauth/connections`,
      { headers: { Authorization: `Api-Key ${"f".repeat(64)}` } },
    );
    expect(rejected.status).toBe(401);
  });
});
