import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CONTROL_PLANE_DIR = fileURLToPath(new URL("..", import.meta.url));
const SESSION_SECRET = "s".repeat(32);
const ACTOR_SIGNING_KEY = "a".repeat(64);
const ACCEPTED_TERMS = JSON.stringify({
  tos_accepted_version: "2026-06-08",
  privacy_policy_accepted_version: "2026-06-08",
  ai_data_sharing_accepted_version: "2026-06-08",
});

const children: Bun.Subprocess[] = [];
const databases: Database[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
    await child.exited;
  }
  for (const db of databases.splice(0)) {
    db.close();
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

function createSeededDatabase(): {
  dbPath: string;
  db: Database;
} {
  const directory = mkdtempSync(join(tmpdir(), "worklin-consent-route-"));
  tempDirs.push(directory);
  const dbPath = join(directory, "control-plane.sqlite");
  const db = new Database(dbPath);
  databases.push(db);
  const timestamp = "2026-07-20T00:00:00.000Z";
  const expiresAt = Math.floor(Date.now() / 1000) + 3_600;
  db.exec(`
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
      runtime_stack_id TEXT,
      isolation_version INTEGER NOT NULL DEFAULT 2,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE organization_memberships (
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'manager', 'collaborator')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'deactivated')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (org_id, user_id)
    );
    CREATE TABLE assistant_assignments (
      org_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (assistant_id, user_id)
    );
  `);
  const insertUser = db.query(
    `INSERT INTO users (
      id, email, username, first_name, last_name, consent_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, '', '', ?, ?, ?)`,
  );
  insertUser.run(
    "user-1",
    "user1@example.com",
    "User One",
    ACCEPTED_TERMS,
    timestamp,
    timestamp,
  );
  insertUser.run(
    "user-2",
    "user2@example.com",
    "User Two",
    ACCEPTED_TERMS,
    timestamp,
    timestamp,
  );
  insertUser.run(
    "user-3",
    "user3@example.com",
    "User Three",
    null,
    timestamp,
    timestamp,
  );
  insertUser.run(
    "user-4",
    "user4@example.com",
    "User Four",
    ACCEPTED_TERMS,
    timestamp,
    timestamp,
  );
  const insertOrganization = db.query(
    `INSERT INTO organizations (
      id, user_id, name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)`,
  );
  insertOrganization.run(
    "org-1",
    "user-1",
    "Workspace One",
    timestamp,
    timestamp,
  );
  insertOrganization.run(
    "org-2",
    "user-2",
    "Workspace Two",
    timestamp,
    timestamp,
  );
  const insertAssistant = db.query(
    `INSERT INTO assistants (
      id, user_id, org_id, name, runtime_stack_id, isolation_version,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, 2, ?, ?)`,
  );
  insertAssistant.run(
    "assistant-1",
    "user-1",
    "org-1",
    "Assistant One",
    timestamp,
    timestamp,
  );
  insertAssistant.run(
    "assistant-2",
    "user-2",
    "org-2",
    "Assistant Two",
    timestamp,
    timestamp,
  );
  const insertSession = db.query(
    `INSERT INTO sessions (id, user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  insertSession.run("session-1", "user-1", expiresAt, timestamp);
  insertSession.run("session-2", "user-2", expiresAt, timestamp);
  insertSession.run("session-3", "user-3", expiresAt, timestamp);
  insertSession.run("session-4", "user-4", expiresAt, timestamp);
  const insertMembership = db.query(
    `INSERT INTO organization_memberships (
      org_id, user_id, role, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertMembership.run(
    "org-1",
    "user-3",
    "collaborator",
    "active",
    timestamp,
    timestamp,
  );
  insertMembership.run(
    "org-1",
    "user-4",
    "admin",
    "active",
    timestamp,
    timestamp,
  );
  db.query(
    `INSERT INTO assistant_assignments (
      org_id, assistant_id, user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run("org-1", "assistant-1", "user-3", timestamp, timestamp);
  return { dbPath, db };
}

function spawnControlPlane(port: number, dbPath: string): Bun.Subprocess {
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

function authHeaders(
  sessionId: string,
  { csrf = false, workspaceId }: { csrf?: boolean; workspaceId?: string } = {},
): Record<string, string> {
  return {
    Cookie: `worklin_session=${sessionId}; csrftoken=csrf-token`,
    "Content-Type": "application/json",
    ...(csrf ? { "X-CSRFToken": "csrf-token" } : {}),
    ...(workspaceId ? { "Vellum-Organization-Id": workspaceId } : {}),
  };
}

describe("assistant admin access consent routes", () => {
  test("keeps consent assistant-scoped for owners, admins, and collaborators", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const { dbPath, db } = createSeededDatabase();
    spawnControlPlane(port, dbPath);
    await waitForHealth(origin);

    const initial = await fetch(
      `${origin}/v1/assistants/assistant-1/access-consent`,
      {
        headers: authHeaders("session-1", { workspaceId: "org-1" }),
      },
    );
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      access_consented: false,
      can_update: true,
    });

    const updated = await fetch(
      `${origin}/v1/assistants/assistant-1/access-consent/`,
      {
        method: "PATCH",
        headers: authHeaders("session-1", {
          csrf: true,
          workspaceId: "org-1",
        }),
        body: JSON.stringify({ access_consented: true }),
      },
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      access_consented: true,
      can_update: true,
    });

    const collaboratorRead = await fetch(
      `${origin}/v1/assistants/assistant-1/access-consent/`,
      {
        headers: authHeaders("session-3", { workspaceId: "org-1" }),
      },
    );
    expect(collaboratorRead.status).toBe(200);
    expect(await collaboratorRead.json()).toEqual({
      access_consented: true,
      can_update: false,
    });

    const collaboratorList = await fetch(
      `${origin}/v1/assistants/?hosting=platform`,
      {
        headers: authHeaders("session-3", { workspaceId: "org-1" }),
      },
    );
    expect(collaboratorList.status).toBe(200);
    const collaboratorPayload = (await collaboratorList.json()) as {
      results: Array<{ id: string; access_consented: boolean }>;
    };
    expect(collaboratorPayload.results).toHaveLength(1);
    expect(collaboratorPayload.results[0]).toMatchObject({
      id: "assistant-1",
      access_consented: true,
    });

    const collaboratorWrite = await fetch(
      `${origin}/v1/assistants/assistant-1/access-consent/`,
      {
        method: "PATCH",
        headers: authHeaders("session-3", {
          csrf: true,
          workspaceId: "org-1",
        }),
        body: JSON.stringify({ access_consented: false }),
      },
    );
    expect(collaboratorWrite.status).toBe(403);

    const adminWrite = await fetch(
      `${origin}/v1/assistants/assistant-1/access-consent/`,
      {
        method: "PATCH",
        headers: authHeaders("session-4", {
          csrf: true,
          workspaceId: "org-1",
        }),
        body: JSON.stringify({ access_consented: false }),
      },
    );
    expect(adminWrite.status).toBe(200);
    expect(await adminWrite.json()).toEqual({
      access_consented: false,
      can_update: true,
    });

    const ownerAfterAdminUpdate = await fetch(
      `${origin}/v1/assistants/assistant-1/access-consent/`,
      {
        headers: authHeaders("session-1", { workspaceId: "org-1" }),
      },
    );
    expect(await ownerAfterAdminUpdate.json()).toEqual({
      access_consented: false,
      can_update: true,
    });

    const crossTenantRead = await fetch(
      `${origin}/v1/assistants/assistant-2/access-consent/`,
      {
        headers: authHeaders("session-1", { workspaceId: "org-1" }),
      },
    );
    expect(crossTenantRead.status).toBe(404);

    const crossTenantWrite = await fetch(
      `${origin}/v1/assistants/assistant-2/access-consent/`,
      {
        method: "PATCH",
        headers: authHeaders("session-1", {
          csrf: true,
          workspaceId: "org-1",
        }),
        body: JSON.stringify({ access_consented: true }),
      },
    );
    expect(crossTenantWrite.status).toBe(404);

    const secondOwner = await fetch(
      `${origin}/v1/assistants/assistant-2/access-consent/`,
      {
        headers: authHeaders("session-2", { workspaceId: "org-2" }),
      },
    );
    expect(secondOwner.status).toBe(200);
    expect(await secondOwner.json()).toEqual({
      access_consented: false,
      can_update: true,
    });

    const persisted = db
      .query<{ assistant: number; terms: string | null }, []>(
        `SELECT
           assistant.admin_access_consented AS assistant,
           user.consent_json AS terms
         FROM assistants AS assistant
         JOIN users AS user ON user.id = assistant.user_id
         WHERE assistant.id = 'assistant-1'`,
      )
      .get();
    expect(persisted).toEqual({
      assistant: 0,
      terms: ACCEPTED_TERMS,
    });
  });

  test("requires an active selected workspace containing the assistant", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const { dbPath, db } = createSeededDatabase();
    spawnControlPlane(port, dbPath);
    await waitForHealth(origin);

    const inaccessibleWorkspace = await fetch(
      `${origin}/v1/assistants/assistant-1/access-consent/`,
      {
        headers: authHeaders("session-1", { workspaceId: "org-2" }),
      },
    );
    expect(inaccessibleWorkspace.status).toBe(403);

    db.query(
      `UPDATE organization_memberships
       SET status = 'deactivated'
       WHERE org_id = 'org-1' AND user_id = 'user-3'`,
    ).run();
    const inactiveMember = await fetch(
      `${origin}/v1/assistants/assistant-1/access-consent/`,
      {
        headers: authHeaders("session-3", { workspaceId: "org-1" }),
      },
    );
    expect(inactiveMember.status).toBe(403);
  });

  test("rejects unsafe or malformed updates without changing consent", async () => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const { dbPath } = createSeededDatabase();
    spawnControlPlane(port, dbPath);
    await waitForHealth(origin);

    const missingCsrf = await fetch(
      `${origin}/v1/assistants/assistant-1/access-consent/`,
      {
        method: "PATCH",
        headers: authHeaders("session-1", { workspaceId: "org-1" }),
        body: JSON.stringify({ access_consented: true }),
      },
    );
    expect(missingCsrf.status).toBe(403);

    const malformed = await fetch(
      `${origin}/v1/assistants/assistant-1/access-consent/`,
      {
        method: "PATCH",
        headers: authHeaders("session-1", {
          csrf: true,
          workspaceId: "org-1",
        }),
        body: JSON.stringify({ access_consented: "yes" }),
      },
    );
    expect(malformed.status).toBe(400);

    const unsupported = await fetch(
      `${origin}/v1/assistants/assistant-1/access-consent/`,
      {
        method: "POST",
        headers: authHeaders("session-1", {
          csrf: true,
          workspaceId: "org-1",
        }),
        body: JSON.stringify({ access_consented: true }),
      },
    );
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get("Allow")).toBe("GET, PATCH");

    const unchanged = await fetch(
      `${origin}/v1/assistants/assistant-1/access-consent/`,
      {
        headers: authHeaders("session-1", { workspaceId: "org-1" }),
      },
    );
    expect(await unchanged.json()).toEqual({
      access_consented: false,
      can_update: true,
    });
  });
});
