import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  assistantApiStatusForRuntimeStack,
  countAllocatedRuntimeServices,
  ensureRuntimeStackForAssistant,
  ensureRuntimeStackSchema,
  getRuntimeStackById,
  isRuntimeStackRoutable,
  markRuntimeStackActive,
  markRuntimeStackFailed,
  markRuntimeStackProvisioning,
  operationalStateForRuntimeStack,
  recordRuntimeStackService,
  recordRuntimeStackVolume,
  runtimeStackConfigFromEnv,
  type AssistantRuntimeRow,
  type RuntimeStackConfig,
} from "./runtime-stacks.js";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE assistants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureRuntimeStackSchema(db);
  db.query(`
    INSERT INTO assistants (id, user_id, org_id, name, created_at, updated_at)
    VALUES ('asst-1', 'user-1', 'org-1', 'Worklin', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z')
  `).run();
  return db;
}

function assistant(
  overrides: Partial<AssistantRuntimeRow> = {},
): AssistantRuntimeRow {
  return {
    id: "asst-1",
    user_id: "user-1",
    org_id: "org-1",
    runtime_stack_id: null,
    ...overrides,
  };
}

function config(
  overrides: Partial<RuntimeStackConfig> = {},
): RuntimeStackConfig {
  return {
    gatewayUrl: "http://gateway.test",
    publicIngressUrl: "https://worklin.example.com",
    requireIsolatedRuntime: true,
    allowLegacySharedRuntime: false,
    runtimeStackUrlTemplate: null,
    runtimeStackProvider: "railway",
    runtimeRoot: "/data",
    ...overrides,
  };
}

const NOW = () => "2026-07-11T12:00:00.000Z";

describe("runtime stack provisioning defaults", () => {
  test("new assistants fail closed when no isolated stack URL is configured", () => {
    const db = setupDb();
    const stack = ensureRuntimeStackForAssistant(db, assistant(), config(), NOW);

    expect(stack.status).toBe("provisioning");
    expect(stack.gateway_url).toBeNull();
    expect(isRuntimeStackRoutable(stack)).toBe(false);
    expect(assistantApiStatusForRuntimeStack(stack)).toBe("initializing");
    expect(operationalStateForRuntimeStack(stack)).toBe("provisioning");

    const row = db
      .query<{ runtime_stack_id: string | null }, []>(
        "SELECT runtime_stack_id FROM assistants WHERE id = 'asst-1'",
      )
      .get();
    expect(row?.runtime_stack_id).toBe(stack.id);
  });

  test("explicit legacy mode routes to the shared gateway for local smoke tests", () => {
    const db = setupDb();
    const stack = ensureRuntimeStackForAssistant(
      db,
      assistant(),
      config({
        requireIsolatedRuntime: false,
        allowLegacySharedRuntime: true,
      }),
      NOW,
    );

    expect(stack.status).toBe("active");
    expect(stack.provider).toBe("legacy_shared");
    expect(stack.gateway_url).toBe("http://gateway.test");
    expect(isRuntimeStackRoutable(stack)).toBe(true);
    expect(assistantApiStatusForRuntimeStack(stack)).toBe("active");
  });

  test("a runtime URL template creates an active stack-specific route", () => {
    const db = setupDb();
    const stack = ensureRuntimeStackForAssistant(
      db,
      assistant(),
      config({
        runtimeStackUrlTemplate:
          "https://private-runtime.example.com/{orgId}/{assistantId}",
        runtimeStackProvider: "static_template",
      }),
      NOW,
    );

    expect(stack.status).toBe("active");
    expect(stack.provider).toBe("static_template");
    expect(stack.gateway_url).toBe(
      "https://private-runtime.example.com/org-1/asst-1",
    );
    expect(isRuntimeStackRoutable(stack)).toBe(true);
  });

  test("ensure is idempotent for the same assistant", () => {
    const db = setupDb();
    const first = ensureRuntimeStackForAssistant(db, assistant(), config(), NOW);
    const second = ensureRuntimeStackForAssistant(
      db,
      assistant({ runtime_stack_id: first.id }),
      config({
        requireIsolatedRuntime: false,
        allowLegacySharedRuntime: true,
      }),
      NOW,
    );

    const count = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM runtime_stacks",
      )
      .get();
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("provisioning");
    expect(count?.count).toBe(1);
  });

  test("persists resumable Railway provisioning state", () => {
    const db = setupDb();
    const initial = ensureRuntimeStackForAssistant(db, assistant(), config(), NOW);

    recordRuntimeStackService(db, initial.id, "service-1", NOW);
    recordRuntimeStackVolume(db, initial.id, "volume-1", NOW);
    expect(countAllocatedRuntimeServices(db)).toBe(1);
    expect(getRuntimeStackById(db, initial.id)).toMatchObject({
      status: "provisioning",
      service_ref: "service-1",
      workspace_volume_ref: "volume-1",
    });

    markRuntimeStackFailed(db, initial.id, "deploy failed", NOW);
    expect(getRuntimeStackById(db, initial.id)).toMatchObject({
      status: "failed",
      last_error: "deploy failed",
    });

    markRuntimeStackProvisioning(db, initial.id, NOW);
    markRuntimeStackActive(
      db,
      initial.id,
      "http://runtime.railway.internal:8080",
      "200",
      NOW,
    );
    expect(getRuntimeStackById(db, initial.id)).toMatchObject({
      status: "active",
      gateway_url: "http://runtime.railway.internal:8080",
      last_health_status: "200",
      last_error: null,
    });
  });
});

describe("runtimeStackConfigFromEnv", () => {
  test("requires isolated runtimes by default", () => {
    expect(
      runtimeStackConfigFromEnv(
        {},
        "http://gateway.test",
        "https://worklin.example.com",
      ),
    ).toMatchObject({
      requireIsolatedRuntime: true,
      allowLegacySharedRuntime: false,
      runtimeStackUrlTemplate: null,
    });
  });
});
