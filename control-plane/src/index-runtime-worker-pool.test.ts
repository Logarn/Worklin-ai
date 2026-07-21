import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureAssistantStoreSchema } from "./assistant-store.js";
import { RUNTIME_WORKER_OPERATOR_RECOVERY_PATH } from "./runtime-worker-operator-recovery.js";
import { ensureRuntimeStackSchema } from "./runtime-stacks.js";

const CONTROL_PLANE_DIR = fileURLToPath(new URL("..", import.meta.url));
const MODEL_KEY_VALIDATION_FETCH_FIXTURE = fileURLToPath(
  new URL("./pooled-model-key-validation.fetch-fixture.mjs", import.meta.url),
);
const SESSION_SECRET = "s".repeat(32);
const ACTOR_SIGNING_KEY = "a".repeat(64);
const OPERATOR_RECOVERY_TOKEN = "r".repeat(64);
const ACCEPTED_CONSENT = JSON.stringify({
  tos_accepted_version: "2026-06-08",
  privacy_policy_accepted_version: "2026-06-08",
  ai_data_sharing_accepted_version: "2026-06-08",
});

const children: Bun.Subprocess[] = [];
const servers: ReturnType<typeof createHttpsServer>[] = [];
const tempDirs: string[] = [];

afterEach(
  async () => {
    for (const child of children.splice(0)) {
      child.kill("SIGKILL");
      await Promise.race([
        child.exited.then(() => undefined),
        Bun.sleep(1_000),
      ]);
    }
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await Promise.race([
        new Promise<void>((resolve) => server.close(() => resolve())),
        Bun.sleep(1_000),
      ]);
    }
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  20_000,
);

async function freePort(): Promise<number> {
  const server = createTcpServer();
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

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "worklin-pooled-index-"));
  tempDirs.push(directory);
  return directory;
}

function generateTestRsaCertificate(directory: string): {
  key: string;
  cert: string;
} {
  const keyPath = join(directory, "worker-key.pem");
  const certPath = join(directory, "worker-cert.pem");
  const result = Bun.spawnSync({
    cmd: [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
    ],
    stdout: "ignore",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) {
    throw new Error("Unable to create a test TLS certificate.");
  }
  return {
    key: readFileSync(keyPath, "utf8"),
    cert: readFileSync(certPath, "utf8"),
  };
}

function createSchema(db: Database): void {
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
  `);
  ensureAssistantStoreSchema(db);
  ensureRuntimeStackSchema(db);
}

function seedPooledAssistant(dbPath: string): void {
  const db = new Database(dbPath);
  createSchema(db);
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO users (
       id, email, username, first_name, last_name, consent_json, created_at,
       updated_at
     ) VALUES (?, ?, ?, '', '', ?, ?, ?)`,
  ).run(
    "user-pool",
    "pool@example.com",
    "pool",
    ACCEPTED_CONSENT,
    now,
    now,
  );
  db.query(
    `INSERT INTO organizations (
       id, user_id, name, is_default, created_at, updated_at
     ) VALUES (?, ?, ?, 1, ?, ?)`,
  ).run("org-pool", "user-pool", "Pool", now, now);
  db.query(
    `INSERT INTO assistants (
       id, user_id, org_id, name, runtime_stack_id, isolation_version,
       is_default, created_at, updated_at
     ) VALUES (?, ?, ?, 'Worklin', ?, 2, 1, ?, ?)`,
  ).run("asst-pool", "user-pool", "org-pool", "rt-asst-pool", now, now);
  db.query(
    `INSERT INTO runtime_stacks (
       id, org_id, assistant_id, status, provider, gateway_url,
       public_ingress_url, workspace_volume_ref, service_ref,
       service_capacity_reserved, service_create_attempted_at,
       volume_create_attempted_at, provisioning_lease_token,
       provisioning_lease_expires_at, actor_signing_key_scope,
       last_health_status, last_error, created_at, updated_at
     ) VALUES (
       ?, ?, ?, 'provisioning', 'railway', NULL, NULL, NULL, NULL,
       0, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, ?
     )`,
  ).run(
    "rt-asst-pool",
    "org-pool",
    "asst-pool",
    "runtime_v1:rt-asst-pool",
    now,
    now,
  );
  db.query(
    "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  ).run(
    "session-pool",
    "user-pool",
    Math.floor(Date.now() / 1_000) + 3_600,
    now,
  );
  db.close();
}

function authHeaders(): Record<string, string> {
  return {
    Cookie: "worklin_session=session-pool; csrftoken=csrf-token",
    "Content-Type": "application/json",
    "X-CSRFToken": "csrf-token",
  };
}

function jwtClaims(authorization: string): Record<string, unknown> {
  const token = authorization.replace(/^Bearer\s+/u, "");
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Missing JWT payload.");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

async function readJsonBody(
  request: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

async function waitForHealth(
  origin: string,
  child?: Bun.Subprocess,
): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (child && child.exitCode !== null) {
      const stderr =
        child.stderr instanceof ReadableStream
          ? await new Response(child.stderr).text()
          : "";
      const stdout =
        child.stdout instanceof ReadableStream
          ? await new Response(child.stdout).text()
          : "";
      throw new Error(
        `Control plane exited during startup.${stderr || stdout ? ` ${(stderr || stdout).trim()}` : ""}`,
      );
    }
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
    } catch {
      // Startup is still performing the fail-closed worker health gate.
    }
    await Bun.sleep(10);
  }
  if (child) {
    child.kill();
    await child.exited;
    const stderr =
      child.stderr instanceof ReadableStream
        ? await new Response(child.stderr).text()
        : "";
    const stdout =
      child.stdout instanceof ReadableStream
        ? await new Response(child.stdout).text()
        : "";
    throw new Error(
      `Control plane did not become healthy.${stderr || stdout ? ` ${(stderr || stdout).trim()}` : ""}`,
    );
  }
  throw new Error("Control plane did not become healthy.");
}

describe("control-plane pooled runtime production bridge", () => {
  test(
    "presents a safe hosted assistant and routes its request with a generation-bound token",
    async () => {
      const directory = tempDirectory();
    const certificate = generateTestRsaCertificate(directory);
    let actorAuthorization = "";
    let voiceDispatcherAuthorization = "";
    let workerModelKeyCapability = "";
    let voiceModelKeyCapability = "";
    let resolvedWorkerModelKey = "";
    let resolvedVoiceModelKey = "";
    let controlPlaneOrigin = "";
    let mutationRequests = 0;
    let signalHeldRequestStarted!: () => void;
    const heldRequestStarted = new Promise<void>((resolve) => {
      signalHeldRequestStarted = resolve;
    });
    let releaseHeldRequest!: () => void;
    const heldRequestRelease = new Promise<void>((resolve) => {
      releaseHeldRequest = resolve;
    });
    const voiceSessionId = "voice-session-pool";
    const voiceExpiresAtMs = Date.now() + 5 * 60_000;
    const voiceSessionToken = `${Buffer.from(
      JSON.stringify({
        version: 1,
        assistantId: "asst-pool",
        sessionId: voiceSessionId,
        expiresAtMs: voiceExpiresAtMs,
      }),
    ).toString("base64url")}.test-signature`;
    const worker = createHttpsServer(
      { key: certificate.key, cert: certificate.cert },
      (request, response) => {
        void (async () => {
          if (request.url === "/readyz" && request.method === "GET") {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end('{"ok":true}');
            return;
          }
          if (
            request.url ===
              "/v1/internal/pooled-worker/state/prepare-empty" &&
            request.method === "POST"
          ) {
            const claims = jwtClaims(request.headers.authorization ?? "");
            const lease = claims.pooled_worker_lease as Record<string, unknown>;
            const body = await readJsonBody(request);
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({
                status: "prepared_empty",
                tenant: {
                  orgId: lease.organization_id,
                  assistantId: lease.assistant_id,
                },
                workerStackId: lease.worker_stack_id,
                leaseGeneration: body.lease_generation,
                remainingTenantPaths: 0,
                credentialsTouched: false,
              }),
            );
            return;
          }
          if (
            request.url ===
              "/v1/assistants/asst-pool/conversations/?hold=1" &&
            request.method === "GET"
          ) {
            signalHeldRequestStarted();
            await heldRequestRelease;
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end('{"results":[]}');
            return;
          }
          if (
            request.url === "/v1/assistants/asst-pool/conversations/" &&
            request.method === "GET"
          ) {
            actorAuthorization = request.headers.authorization ?? "";
            workerModelKeyCapability =
              String(
                request.headers["x-worklin-pooled-model-key-capability"] ?? "",
              );
            const keyResponse = await fetch(
              `${controlPlaneOrigin}/internal/v1/runtime-workers/model-provider-key`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${workerModelKeyCapability}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ provider: "openai" }),
              },
            );
            const keyBody = (await keyResponse.json()) as { value?: string };
            resolvedWorkerModelKey = keyBody.value ?? "";
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end('{"results":[]}');
            return;
          }
          if (
            request.url === "/v1/assistants/asst-pool/conversations/" &&
            request.method === "POST"
          ) {
            mutationRequests += 1;
            await readJsonBody(request);
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end('{"id":"conversation-pool"}');
            return;
          }
          if (
            request.url ===
              "/v1/assistants/asst-pool/live-voice/sessions" &&
            request.method === "POST"
          ) {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({
                sessionId: voiceSessionId,
                conversationId: "conversation-voice-pool",
                engine: "hume",
                expiresAt: new Date(voiceExpiresAtMs).toISOString(),
                connection: {
                  transport: "hume",
                  websocketUrl: "wss://voice.example.invalid",
                  sessionToken: voiceSessionToken,
                },
              }),
            );
            return;
          }
          if (
            request.url?.startsWith(
              "/v1/live-voice/providers/chat/completions?",
            ) &&
            request.method === "POST"
          ) {
            voiceDispatcherAuthorization =
              String(
                request.headers["x-worklin-runtime-authorization"] ?? "",
              );
            voiceModelKeyCapability =
              String(
                request.headers["x-worklin-pooled-model-key-capability"] ?? "",
              );
            const keyResponse = await fetch(
              `${controlPlaneOrigin}/internal/v1/runtime-workers/model-provider-key`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${voiceModelKeyCapability}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ provider: "openai" }),
              },
            );
            const keyBody = (await keyResponse.json()) as { value?: string };
            resolvedVoiceModelKey = keyBody.value ?? "";
            response.writeHead(200, {
              "Content-Type": "text/event-stream",
            });
            response.end("data: [DONE]\n\n");
            return;
          }
          response.writeHead(404);
          response.end();
        })().catch(() => {
          response.writeHead(500);
          response.end();
        });
      },
    );
    servers.push(worker);
    await new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.listen(0, "127.0.0.1", resolve);
    });
    const address = worker.address();
    if (!address || typeof address === "string") {
      throw new Error("Worker did not bind.");
    }
    const workerOrigin = `https://127.0.0.1:${address.port}`;

    const dbPath = join(directory, "control-plane.sqlite");
    const providerValidationAuditPath = join(
      directory,
      "provider-validation-audit.jsonl",
    );
    seedPooledAssistant(dbPath);
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    controlPlaneOrigin = origin;
    const serviceAccount = JSON.stringify({
    client_email: "pool-test@example.com",
      private_key: certificate.key,
    });
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "run",
        "--preload",
        MODEL_KEY_VALIDATION_FETCH_FIXTURE,
        "src/index.ts",
      ],
      cwd: CONTROL_PLANE_DIR,
      env: {
        ...process.env,
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
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
        WORKLIN_RUNTIME_MODE: "control-plane",
        WORKLIN_REQUIRE_ISOLATED_RUNTIME: "true",
        WORKLIN_ALLOW_LEGACY_SHARED_RUNTIME: "false",
        WORKLIN_RAILWAY_PROVISIONING_ENABLED: "false",
        WORKLIN_RUNTIME_WORKER_CATALOG_ENABLED: "true",
        WORKLIN_RUNTIME_WORKER_CATALOG_JSON: JSON.stringify([
          {
            workerId: "pool-worker-1",
            gatewayUrl: workerOrigin,
            serviceRef: "service-pool-worker-1",
            capacity: { maxConcurrentLeases: 1 },
          },
        ]),
        WORKLIN_RUNTIME_WORKER_POOL_ENABLED: "true",
        WORKLIN_CONTROL_PLANE_EXPECTED_REPLICA_COUNT: "1",
        RAILWAY_DEPLOYMENT_ID: "deployment-pool-test",
        RAILWAY_REPLICA_ID: "replica-pool-test",
        WORKLIN_RUNTIME_WORKER_POOL_STACK_IDS: "pool-worker-1",
        WORKLIN_RUNTIME_WORKER_POOL_MAX_CONCURRENCY: "1",
        WORKLIN_RUNTIME_WORKER_POOL_LEASE_TTL_MS: "60000",
        WORKLIN_RUNTIME_WORKER_OPERATOR_RECOVERY_TOKEN:
          OPERATOR_RECOVERY_TOKEN,
        WORKLIN_POOLED_MODEL_KEY_VAULT_ENABLED: "true",
        WORKLIN_POOLED_MODEL_KEY_VAULT_MASTER_KEY: "c".repeat(64),
        WORKLIN_TEST_PROVIDER_VALIDATION_AUDIT_PATH:
          providerValidationAuditPath,
        WORKLIN_RUNTIME_WORKER_PRODUCTION_TRANSPORT_ENABLED: "true",
        WORKLIN_RUNTIME_WORKER_STATE_BUCKET: "worklin-pool-test-state",
        WORKLIN_RUNTIME_WORKER_STATE_GCS_SERVICE_ACCOUNT_JSON: serviceAccount,
        WORKLIN_RUNTIME_WORKER_HEALTH_PROBE_ENABLED: "true",
        WORKLIN_RUNTIME_WORKER_HEALTH_PROBE_TIMEOUT_MS: "5000",
        WORKLIN_TENANT_RUNTIME_OPERATIONS_ENABLED: "true",
        WORKLIN_TENANT_RUNTIME_ADMISSION_ENABLED: "true",
        WORKLIN_TENANT_STORAGE_QUOTA_ENFORCEMENT_ENABLED: "true",
        WORKLIN_TENANT_USAGE_METRICS_ENABLED: "true",
        WORKLIN_TENANT_IDLE_SUSPENSION_ENABLED: "true",
        WORKLIN_RUNTIME_CAPACITY_ALERTS_ENABLED: "true",
        WORKLIN_TENANT_STORAGE_QUOTA_BYTES: String(12 * 1_024 * 1_024),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    await waitForHealth(origin, child);

    const unauthorizedRecovery = await fetch(
      `${origin}${RUNTIME_WORKER_OPERATOR_RECOVERY_PATH}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(unauthorizedRecovery.status).toBe(401);
    const malformedRecovery = await fetch(
      `${origin}${RUNTIME_WORKER_OPERATOR_RECOVERY_PATH}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPERATOR_RECOVERY_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    expect(malformedRecovery.status).toBe(400);
    const recoveryCandidates = await fetch(
      `${origin}${RUNTIME_WORKER_OPERATOR_RECOVERY_PATH}`,
      {
        headers: {
          Authorization: `Bearer ${OPERATOR_RECOVERY_TOKEN}`,
        },
      },
    );
    expect(recoveryCandidates.status).toBe(200);
    expect(await recoveryCandidates.json()).toEqual({ candidates: [] });

    const assistantResponse = await fetch(
      `${origin}/v1/assistants/active/`,
      { headers: authHeaders() },
    );
    expect(assistantResponse.status).toBe(200);
    expect(await assistantResponse.json()).toMatchObject({
      id: "asst-pool",
      status: "active",
      runtime_status: "active",
      runtime_provider: "pooled_worker",
      ingress_url: null,
      platform_actor_token: null,
    });

    const hatchResponse = await fetch(`${origin}/v1/assistants/hatch/`, {
      method: "POST",
      headers: authHeaders(),
      body: "{}",
    });
    expect([200, 201]).toContain(hatchResponse.status);
    expect(await hatchResponse.json()).toMatchObject({
      id: "asst-pool",
      status: "active",
      runtime_status: "active",
      runtime_provider: "pooled_worker",
    });

    const modelKey = "test-openai-key-tenant-pool";
    const saveKeyResponse = await fetch(
      `${origin}/v1/assistants/asst-pool/secrets`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          type: "api_key",
          name: "openai",
          value: modelKey,
        }),
      },
    );
    expect(saveKeyResponse.status).toBe(200);
    expect(await saveKeyResponse.json()).toEqual({
      success: true,
      type: "api_key",
      name: "openai",
    });

    const invalidRotation = "test-invalid-openai-key-tenant-pool";
    const invalidRotationResponse = await fetch(
      `${origin}/v1/assistants/asst-pool/secrets`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          type: "api_key",
          name: "openai",
          value: invalidRotation,
        }),
      },
    );
    expect(invalidRotationResponse.status).toBe(400);
    const invalidRotationBody = await invalidRotationResponse.json();
    expect(invalidRotationBody).toEqual({
      detail: "openai API key was not saved. OpenAI rejected this API key.",
    });
    expect(JSON.stringify(invalidRotationBody)).not.toContain(invalidRotation);
    expect(
      readFileSync(providerValidationAuditPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        url: "https://api.openai.com/v1/models",
        credentialHeader: "authorization",
        outcome: "accepted",
      },
      {
        url: "https://api.openai.com/v1/models",
        credentialHeader: "authorization",
        outcome: "rejected",
      },
    ]);

    const revealKeyResponse = await fetch(
      `${origin}/v1/assistants/asst-pool/secrets/read`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          type: "api_key",
          name: "openai",
          reveal: true,
        }),
      },
    );
    expect(revealKeyResponse.status).toBe(200);
    const revealKeyBody = await revealKeyResponse.json();
    expect(JSON.stringify(revealKeyBody)).not.toContain(modelKey);
    expect(revealKeyBody).toMatchObject({
      found: true,
      revealSupported: false,
    });

    const heldResponsePromise = fetch(
      `${origin}/v1/assistants/asst-pool/conversations/?hold=1`,
      { headers: authHeaders() },
    );
    await Promise.race([
      heldRequestStarted,
      Bun.sleep(1_000).then(() => {
        throw new Error("Held pooled request did not reach the worker.");
      }),
    ]);
    const busyRotation = "test-openai-rotation-key-tenant-pool";
    const busyRotationResponse = await fetch(
      `${origin}/v1/assistants/asst-pool/secrets`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          type: "api_key",
          name: "openai",
          value: busyRotation,
        }),
      },
    );
    expect(busyRotationResponse.status).toBe(409);
    const busyRotationBody = await busyRotationResponse.json();
    expect(busyRotationBody).toEqual({
      detail:
        "Model provider settings cannot change while this assistant is handling a request.",
      code: "pooled_runtime_model_provider_configuration_busy",
    });
    expect(JSON.stringify(busyRotationBody)).not.toContain(busyRotation);
    expect(
      readFileSync(providerValidationAuditPath, "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(2);
    releaseHeldRequest();
    const heldResponse = await heldResponsePromise;
    expect(heldResponse.status).toBe(200);
    expect(await heldResponse.json()).toEqual({ results: [] });

    const response = await fetch(
      `${origin}/v1/assistants/asst-pool/conversations/`,
      {
        headers: {
          ...authHeaders(),
          Authorization: "Bearer forged-client-token",
          "X-Vellum-Proxy-Server": "ipc",
          "X-Worklin-Pooled-Model-Key-Capability": "forged-capability",
        },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [] });
    expect(actorAuthorization).toStartWith("Bearer ");
    expect(actorAuthorization).not.toBe("Bearer forged-client-token");
    const claims = jwtClaims(actorAuthorization);
    expect(claims.scope_profile).toBe("actor_client_v1");
    expect(claims.tenant_context).toMatchObject({
      organization_id: "org-pool",
      user_id: "user-pool",
      assistant_id: "asst-pool",
    });
    expect(claims.pooled_worker_lease).toMatchObject({
      organization_id: "org-pool",
      user_id: "user-pool",
      assistant_id: "asst-pool",
      worker_stack_id: "pool-worker-1",
      lease_generation: 1,
    });
    expect(workerModelKeyCapability).not.toBe("forged-capability");
    expect(workerModelKeyCapability.split(".")).toHaveLength(3);
    expect(resolvedWorkerModelKey).toBe(modelKey);

    const replayResponse = await fetch(
      `${origin}/internal/v1/runtime-workers/model-provider-key`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${workerModelKeyCapability}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider: "openai" }),
      },
    );
    expect(replayResponse.status).toBe(401);

    const voiceBootstrapResponse = await fetch(
      `${origin}/v1/assistants/asst-pool/live-voice/sessions`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ assistantId: "asst-pool" }),
      },
    );
    expect(voiceBootstrapResponse.status).toBe(409);
    expect(await voiceBootstrapResponse.json()).toMatchObject({
      code: "pooled_runtime_managed_live_voice_route_unsupported",
    });
    expect(voiceDispatcherAuthorization).toBe("");
    expect(voiceModelKeyCapability).toBe("");
    expect(resolvedVoiceModelKey).toBe("");

    // The quota is inclusive: three 4 MiB reservations exactly fill the
    // configured 12 MiB allowance. Only the next byte-increasing operation
    // must be rejected.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const mutationResponse = await fetch(
        `${origin}/v1/assistants/asst-pool/conversations/`,
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ title: `Conversation ${attempt + 1}` }),
        },
      );
      expect(mutationResponse.status).toBe(200);
    }

    const overQuotaResponse = await fetch(
      `${origin}/v1/assistants/asst-pool/conversations/`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ title: "Conversation 4" }),
      },
    );
    expect(overQuotaResponse.status).toBe(413);
    expect(await overQuotaResponse.json()).toMatchObject({
      code: "tenant_runtime_storage_quota_exceeded",
    });
      expect(mutationRequests).toBe(3);
    },
    20_000,
  );
});
