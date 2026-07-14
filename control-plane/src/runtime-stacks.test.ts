import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

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
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE
    );
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
    INSERT INTO users (id, email) VALUES ('user-1', 'pilot@example.com')
  `).run();
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
    legacySharedRuntimeAssistantIds: [],
    legacySharedRuntimeUserEmailHashes: [],
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

  test("explicit legacy mode fails closed outside a configured pilot allowlist", () => {
    const db = setupDb();
    const stack = ensureRuntimeStackForAssistant(
      db,
      assistant(),
      config({
        requireIsolatedRuntime: false,
        allowLegacySharedRuntime: true,
        legacySharedRuntimeUserEmailHashes: [
          createHash("sha256")
            .update("another@example.com")
            .digest("hex"),
        ],
      }),
      NOW,
    );

    expect(stack.status).toBe("provisioning");
    expect(stack.provider).toBe("railway");
    expect(stack.gateway_url).toBeNull();
  });

  test("explicit legacy mode routes a user whose normalized email hash is allowlisted", () => {
    const db = setupDb();
    const stack = ensureRuntimeStackForAssistant(
      db,
      assistant(),
      config({
        requireIsolatedRuntime: false,
        allowLegacySharedRuntime: true,
        legacySharedRuntimeUserEmailHashes: [
          createHash("sha256").update("pilot@example.com").digest("hex"),
        ],
      }),
      NOW,
    );

    expect(stack.status).toBe("active");
    expect(stack.provider).toBe("legacy_shared");
  });

  test("explicit legacy mode routes an allowlisted pilot assistant", () => {
    const db = setupDb();
    const stack = ensureRuntimeStackForAssistant(
      db,
      assistant(),
      config({
        requireIsolatedRuntime: false,
        allowLegacySharedRuntime: true,
        legacySharedRuntimeAssistantIds: ["asst-1"],
        legacySharedRuntimeUserEmailHashes: ["not-the-user-email-hash"],
      }),
      NOW,
    );

    expect(stack.status).toBe("active");
    expect(stack.provider).toBe("legacy_shared");
  });

  test("explicit legacy mode fails closed outside an assistant-only pilot allowlist", () => {
    const db = setupDb();
    const stack = ensureRuntimeStackForAssistant(
      db,
      assistant(),
      config({
        requireIsolatedRuntime: false,
        allowLegacySharedRuntime: true,
        legacySharedRuntimeAssistantIds: ["asst-another"],
      }),
      NOW,
    );

    expect(stack.status).toBe("provisioning");
    expect(stack.provider).toBe("railway");
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

  test("explicit legacy mode recovers an unallocated provisioning Railway stack", () => {
    const db = setupDb();
    const first = ensureRuntimeStackForAssistant(db, assistant(), config(), NOW);
    const second = ensureRuntimeStackForAssistant(
      db,
      assistant({ runtime_stack_id: first.id }),
      config({
        requireIsolatedRuntime: false,
        allowLegacySharedRuntime: true,
        legacySharedRuntimeAssistantIds: ["asst-1"],
        legacySharedRuntimeUserEmailHashes: ["not-the-user-email-hash"],
      }),
      NOW,
    );

    const count = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM runtime_stacks",
      )
      .get();
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({
      status: "active",
      provider: "legacy_shared",
      gateway_url: "http://gateway.test",
      public_ingress_url: "https://worklin.example.com",
      workspace_volume_ref: "/data",
      service_ref: "legacy-shared-runtime",
      last_health_status: null,
      last_error: null,
    });
    expect(count?.count).toBe(1);
  });

  test("explicit legacy mode recovers an unallocated failed Railway stack idempotently", () => {
    const db = setupDb();
    const initial = ensureRuntimeStackForAssistant(db, assistant(), config(), NOW);
    markRuntimeStackFailed(db, initial.id, "provisioning unavailable", NOW);
    const sharedConfig = config({
      requireIsolatedRuntime: false,
      allowLegacySharedRuntime: true,
    });

    const recovered = ensureRuntimeStackForAssistant(
      db,
      assistant({ runtime_stack_id: initial.id }),
      sharedConfig,
      NOW,
    );
    const repeated = ensureRuntimeStackForAssistant(
      db,
      assistant({ runtime_stack_id: initial.id }),
      sharedConfig,
      NOW,
    );

    expect(recovered).toMatchObject({
      id: initial.id,
      status: "active",
      provider: "legacy_shared",
      gateway_url: "http://gateway.test",
      service_ref: "legacy-shared-runtime",
      last_error: null,
    });
    expect(repeated).toEqual(recovered);
  });

  test("legacy recovery refuses a Railway stack with an allocated service", () => {
    const db = setupDb();
    const initial = ensureRuntimeStackForAssistant(db, assistant(), config(), NOW);
    recordRuntimeStackService(db, initial.id, "service-1", NOW);
    markRuntimeStackFailed(db, initial.id, "deploy failed", NOW);

    const stack = ensureRuntimeStackForAssistant(
      db,
      assistant({ runtime_stack_id: initial.id }),
      config({
        requireIsolatedRuntime: false,
        allowLegacySharedRuntime: true,
      }),
      NOW,
    );

    expect(stack).toMatchObject({
      status: "failed",
      provider: "railway",
      gateway_url: null,
      service_ref: "service-1",
      last_error: "deploy failed",
    });
  });

  test("legacy recovery refuses a Railway stack with an allocated volume", () => {
    const db = setupDb();
    const initial = ensureRuntimeStackForAssistant(db, assistant(), config(), NOW);
    recordRuntimeStackVolume(db, initial.id, "volume-1", NOW);
    markRuntimeStackFailed(db, initial.id, "deploy failed", NOW);

    const stack = ensureRuntimeStackForAssistant(
      db,
      assistant({ runtime_stack_id: initial.id }),
      config({
        requireIsolatedRuntime: false,
        allowLegacySharedRuntime: true,
      }),
      NOW,
    );

    expect(stack).toMatchObject({
      status: "failed",
      provider: "railway",
      gateway_url: null,
      workspace_volume_ref: "volume-1",
      last_error: "deploy failed",
    });
  });

  test("legacy recovery refuses a Railway stack with an existing gateway", () => {
    const db = setupDb();
    const initial = ensureRuntimeStackForAssistant(db, assistant(), config(), NOW);
    db.query(`
      UPDATE runtime_stacks
      SET gateway_url = 'http://allocated-runtime.test', status = 'failed'
      WHERE id = ?
    `).run(initial.id);

    const stack = ensureRuntimeStackForAssistant(
      db,
      assistant({ runtime_stack_id: initial.id }),
      config({
        requireIsolatedRuntime: false,
        allowLegacySharedRuntime: true,
      }),
      NOW,
    );

    expect(stack).toMatchObject({
      status: "failed",
      provider: "railway",
      gateway_url: "http://allocated-runtime.test",
      service_ref: null,
      workspace_volume_ref: null,
    });
  });

  test("shared recovery requires isolated mode to be explicitly disabled", () => {
    const db = setupDb();
    const initial = ensureRuntimeStackForAssistant(db, assistant(), config(), NOW);
    markRuntimeStackFailed(db, initial.id, "provisioning unavailable", NOW);

    const stack = ensureRuntimeStackForAssistant(
      db,
      assistant({ runtime_stack_id: initial.id }),
      config({ allowLegacySharedRuntime: true }),
      NOW,
    );

    expect(stack).toMatchObject({
      status: "failed",
      provider: "railway",
      gateway_url: null,
      service_ref: null,
      workspace_volume_ref: null,
      last_error: "provisioning unavailable",
    });
  });

  test("shared recovery fails closed outside the configured pilot allowlist", () => {
    const db = setupDb();
    const initial = ensureRuntimeStackForAssistant(db, assistant(), config(), NOW);
    markRuntimeStackFailed(db, initial.id, "provisioning unavailable", NOW);

    const stack = ensureRuntimeStackForAssistant(
      db,
      assistant({ runtime_stack_id: initial.id }),
      config({
        requireIsolatedRuntime: false,
        allowLegacySharedRuntime: true,
        legacySharedRuntimeUserEmailHashes: [
          createHash("sha256")
            .update("another@example.com")
            .digest("hex"),
        ],
      }),
      NOW,
    );

    expect(stack).toMatchObject({
      status: "failed",
      provider: "railway",
      gateway_url: null,
      service_ref: null,
      workspace_volume_ref: null,
    });
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
      legacySharedRuntimeAssistantIds: [],
      legacySharedRuntimeUserEmailHashes: [],
      runtimeStackUrlTemplate: null,
    });
  });

  test("parses a trimmed pilot user-email-hash allowlist", () => {
    expect(
      runtimeStackConfigFromEnv(
        {
          WORKLIN_LEGACY_SHARED_RUNTIME_USER_EMAIL_HASHES:
            "hash-1, hash-2, ,hash-3",
        },
        "http://gateway.test",
        "https://worklin.example.com",
      ).legacySharedRuntimeUserEmailHashes,
    ).toEqual(["hash-1", "hash-2", "hash-3"]);
  });

  test("parses a trimmed pilot assistant allowlist", () => {
    expect(
      runtimeStackConfigFromEnv(
        {
          WORKLIN_LEGACY_SHARED_RUNTIME_ASSISTANT_IDS:
            "asst-1, asst-2, ,asst-3",
        },
        "http://gateway.test",
        "https://worklin.example.com",
      ).legacySharedRuntimeAssistantIds,
    ).toEqual(["asst-1", "asst-2", "asst-3"]);
  });
});
