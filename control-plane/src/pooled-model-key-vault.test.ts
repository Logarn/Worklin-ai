import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  POOLED_MODEL_KEY_CAPABILITY_TTL_SECONDS,
  POOLED_MODEL_KEY_PROVIDERS,
  PooledModelKeyVault,
  pooledModelKeyVaultConfigFromEnv,
  type PooledModelKeyValidator,
} from "./pooled-model-key-vault.js";
import {
  isRuntimeWorkerBootstrapInferenceProvider,
  RUNTIME_WORKER_BOOTSTRAP_INFERENCE_PROVIDERS,
} from "./runtime-worker-production-transport.js";
import { ensureRuntimeStackSchema } from "./runtime-stacks.js";
import {
  claimRuntimeWorkerLease,
  markRuntimeWorkerSanitized,
  releaseRuntimeWorkerLease,
  renewRuntimeWorkerLease,
  RUNTIME_WORKER_POOL_PROVIDER,
} from "./runtime-worker-leases.js";
import { resolveActiveRuntimeWorkerLeaseServiceBinding } from "./runtime-worker-service-tokens.js";

const MASTER_KEY = "a".repeat(64);
const NOW_ISO = "2026-07-20T10:00:00.000Z";
const TENANT_ONE = {
  organizationId: "org-1",
  userId: "user-1",
  assistantId: "asst-1",
} as const;
const TENANT_TWO = {
  organizationId: "org-2",
  userId: "user-2",
  assistantId: "asst-2",
} as const;

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
    INSERT INTO assistants (id, user_id, org_id, name, created_at, updated_at)
    VALUES
      ('asst-1', 'user-1', 'org-1', 'Assistant One', '${NOW_ISO}', '${NOW_ISO}'),
      ('asst-2', 'user-2', 'org-2', 'Assistant Two', '${NOW_ISO}', '${NOW_ISO}');
  `);
  ensureRuntimeStackSchema(db);
  db.exec(`
    INSERT INTO runtime_stacks (
      id, org_id, assistant_id, status, provider, gateway_url,
      public_ingress_url, workspace_volume_ref, service_ref,
      actor_signing_key_scope, last_health_status, last_error,
      created_at, updated_at
    ) VALUES (
      'worker-1', 'pool', 'pool-owner', 'active',
      '${RUNTIME_WORKER_POOL_PROVIDER}',
      'http://worker-1.internal', 'https://worklin.example.com',
      NULL, 'service-worker-1', 'runtime_v1:worker-1',
      '200', NULL, '${NOW_ISO}', '${NOW_ISO}'
    );
  `);
  return db;
}

const acceptProviderKey: PooledModelKeyValidator = async () => ({
  valid: true,
});

function enabledVault(
  db: Database,
  validateProviderKey: PooledModelKeyValidator = acceptProviderKey,
): PooledModelKeyVault {
  return new PooledModelKeyVault(
    db,
    pooledModelKeyVaultConfigFromEnv({
      WORKLIN_POOLED_MODEL_KEY_VAULT_ENABLED: "true",
      WORKLIN_POOLED_MODEL_KEY_VAULT_MASTER_KEY: MASTER_KEY,
    }),
    validateProviderKey,
  );
}

function claim(
  db: Database,
  tenant: {
    organizationId: string;
    userId: string;
    assistantId: string;
  } = TENANT_ONE,
  nowMs = 1_000,
): void {
  const result = claimRuntimeWorkerLease(
    db,
    { id: tenant.assistantId, org_id: tenant.organizationId },
    ["worker-1"],
    1,
    `lease-${tenant.assistantId}`,
    nowMs,
    60_000,
    () => NOW_ISO,
  );
  expect(result.reason).toBe("acquired");
}

function activeBinding(db: Database, nowMs = 1_001) {
  const binding = resolveActiveRuntimeWorkerLeaseServiceBinding(
    db,
    "worker-1",
    nowMs,
  );
  if (!binding) throw new Error("Expected active worker binding.");
  return binding;
}

describe("pooled model provider key vault", () => {
  test("covers the six-minute pooled turn with a bounded drain margin", () => {
    expect(POOLED_MODEL_KEY_CAPABILITY_TTL_SECONDS).toBe(7 * 60);
    expect(POOLED_MODEL_KEY_CAPABILITY_TTL_SECONDS).toBeGreaterThan(6 * 60);
  });

  test("is disabled by default and rejects malformed master keys", () => {
    expect(pooledModelKeyVaultConfigFromEnv({})).toEqual({ enabled: false });
    expect(() =>
      pooledModelKeyVaultConfigFromEnv({
        WORKLIN_POOLED_MODEL_KEY_VAULT_ENABLED: "true",
        WORKLIN_POOLED_MODEL_KEY_VAULT_MASTER_KEY: "not-a-key",
      }),
    ).toThrow("exactly 64 hexadecimal characters");
  });

  test("accepts exactly the bootstrap-capable providers and one provider per tenant", async () => {
    expect(
      POOLED_MODEL_KEY_PROVIDERS.filter(
        isRuntimeWorkerBootstrapInferenceProvider,
      ),
    ).toEqual([...RUNTIME_WORKER_BOOTSTRAP_INFERENCE_PROVIDERS]);

    const db = setupDb();
    const vault = enabledVault(db);
    for (const provider of RUNTIME_WORKER_BOOTSTRAP_INFERENCE_PROVIDERS) {
      expect(
        await vault.handleSecretRoute({
          method: "POST",
          routeSegments: ["secrets"],
          tenant: TENANT_ONE,
          body: {
            type: "api_key",
            name: provider,
            value: `key-${provider}`,
          },
        }),
      ).toMatchObject({ status: 200 });
      expect(
        await vault.handleSecretRoute({
          method: "DELETE",
          routeSegments: ["secrets"],
          tenant: TENANT_ONE,
          body: { type: "api_key", name: provider },
        }),
      ).toMatchObject({ status: 200 });
    }

    expect(
      await vault.handleSecretRoute({
        method: "POST",
        routeSegments: ["secrets"],
        tenant: TENANT_ONE,
        body: {
          type: "api_key",
          name: "openai-compatible",
          value: "key-without-required-provider-metadata",
        },
      }),
    ).toMatchObject({
      status: 409,
      body: {
        code: "pooled_runtime_model_provider_requires_dedicated_runtime",
      },
    });

    vault.set(TENANT_ONE, "anthropic", "key-one", NOW_ISO);
    expect(
      await vault.handleSecretRoute({
        method: "POST",
        routeSegments: ["secrets"],
        tenant: TENANT_ONE,
        body: { type: "api_key", name: "openai", value: "key-two" },
      }),
    ).toMatchObject({
      status: 409,
      body: { code: "pooled_runtime_single_model_provider_required" },
    });
    expect(
      await vault.handleSecretRoute({
        method: "POST",
        routeSegments: ["secrets"],
        tenant: TENANT_ONE,
        body: {
          type: "api_key",
          name: "anthropic",
          value: "rotated-key-one",
        },
      }),
    ).toMatchObject({ status: 200 });
    expect(vault.list(TENANT_ONE)).toEqual(["anthropic"]);
    expect(vault.get(TENANT_ONE, "anthropic")).toBe("rotated-key-one");
  });

  test("rejects dedicated and unknown providers before validation or persistence", async () => {
    const db = setupDb();
    let validationCalls = 0;
    const vault = enabledVault(db, async () => {
      validationCalls += 1;
      return { valid: true };
    });

    expect(
      await vault.handleSecretRoute({
        method: "POST",
        routeSegments: ["secrets"],
        tenant: TENANT_ONE,
        body: {
          type: "api_key",
          name: "openai-compatible",
          value: "dedicated-runtime-key",
        },
      }),
    ).toMatchObject({
      status: 409,
      body: {
        code: "pooled_runtime_model_provider_requires_dedicated_runtime",
      },
    });
    for (const provider of ["xai", "other-provider"]) {
      expect(
        await vault.handleSecretRoute({
          method: "POST",
          routeSegments: ["secrets"],
          tenant: TENANT_ONE,
          body: {
            type: "api_key",
            name: provider,
            value: "unsupported-provider-key",
          },
        }),
      ).toMatchObject({ status: 400 });
    }

    expect(validationCalls).toBe(0);
    expect(vault.list(TENANT_ONE)).toEqual([]);
  });

  test("does not overwrite a valid stored key when rotation validation fails", async () => {
    const db = setupDb();
    const validKey = "verified-openai-key";
    const invalidRotation = "rejected-openai-key";
    const vault = enabledVault(db, async (_provider, value) =>
      value === validKey
        ? { valid: true }
        : { valid: false, reason: "OpenAI rejected this API key." },
    );

    expect(
      await vault.handleSecretRoute({
        method: "POST",
        routeSegments: ["secrets"],
        tenant: TENANT_ONE,
        body: { type: "api_key", name: "openai", value: validKey },
      }),
    ).toMatchObject({ status: 200 });
    const before = db
      .query<
        { nonce: string; ciphertext: string; auth_tag: string; updated_at: string },
        []
      >(
        `SELECT nonce, ciphertext, auth_tag, updated_at
           FROM pooled_model_provider_keys`,
      )
      .get();

    const rejected = await vault.handleSecretRoute({
      method: "POST",
      routeSegments: ["secrets"],
      tenant: TENANT_ONE,
      body: {
        type: "api_key",
        name: "openai",
        value: invalidRotation,
      },
    });

    expect(rejected).toEqual({
      status: 400,
      body: {
        detail:
          "openai API key was not saved. OpenAI rejected this API key.",
      },
    });
    expect(JSON.stringify(rejected)).not.toContain(invalidRotation);
    expect(
      db
        .query<
          {
            nonce: string;
            ciphertext: string;
            auth_tag: string;
            updated_at: string;
          },
          []
        >(
          `SELECT nonce, ciphertext, auth_tag, updated_at
             FROM pooled_model_provider_keys`,
        )
        .get(),
    ).toEqual(before);
    expect(vault.get(TENANT_ONE, "openai")).toBe(validKey);
  });

  test("encrypts at rest with tenant-bound AAD and isolates tenant rows", () => {
    const db = setupDb();
    const vault = enabledVault(db);
    vault.set(TENANT_ONE, "openai", "sk-tenant-one", NOW_ISO);
    vault.set(TENANT_TWO, "openai", "sk-tenant-two", NOW_ISO);

    const rows = db
      .query<{ organization_id: string; ciphertext: string }, []>(
        `SELECT organization_id, ciphertext
           FROM pooled_model_provider_keys
          ORDER BY organization_id`,
      )
      .all();
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain("sk-tenant-one");
    expect(JSON.stringify(rows)).not.toContain("sk-tenant-two");
    expect(vault.get(TENANT_ONE, "openai")).toBe("sk-tenant-one");
    expect(vault.get(TENANT_TWO, "openai")).toBe("sk-tenant-two");
    expect(vault.list(TENANT_ONE)).toEqual(["openai"]);

    db.query(
      `UPDATE pooled_model_provider_keys
          SET organization_id = 'org-3'
        WHERE organization_id = 'org-1'`,
    ).run();
    expect(() =>
      vault.get({ ...TENANT_ONE, organizationId: "org-3" }, "openai"),
    ).toThrow("could not be decrypted");
  });

  test("pins the persisted vault to one stable master key", () => {
    const db = setupDb();
    const vault = enabledVault(db);
    vault.set(TENANT_ONE, "openai", "sk-tenant-one", NOW_ISO);

    expect(enabledVault(db).get(TENANT_ONE, "openai")).toBe("sk-tenant-one");
    expect(
      () =>
        new PooledModelKeyVault(
          db,
          pooledModelKeyVaultConfigFromEnv({
            WORKLIN_POOLED_MODEL_KEY_VAULT_ENABLED: "true",
            WORKLIN_POOLED_MODEL_KEY_VAULT_MASTER_KEY: "b".repeat(64),
          }),
        ),
    ).toThrow("does not match persisted ciphertext");
    const metadata = db
      .query<
        { key_verifier: string },
        []
      >("SELECT key_verifier FROM pooled_model_key_vault_meta WHERE singleton = 1")
      .get();
    expect(metadata?.key_verifier).toHaveLength(64);
    expect(JSON.stringify(metadata)).not.toContain(MASTER_KEY);
  });

  test("preserves the existing API-key secret response shapes", async () => {
    const db = setupDb();
    const vault = enabledVault(db);
    expect(
      await vault.handleSecretRoute({
        method: "POST",
        routeSegments: ["secrets"],
        tenant: TENANT_ONE,
        body: {
          type: "api_key",
          name: "anthropic",
          value: "sk-ant-tenant-one",
        },
      }),
    ).toEqual({
      status: 200,
      body: { success: true, type: "api_key", name: "anthropic" },
    });
    expect(
      await vault.handleSecretRoute({
        method: "GET",
        routeSegments: ["secrets"],
        tenant: TENANT_ONE,
      }),
    ).toEqual({
      status: 200,
      body: {
        secrets: [{ type: "api_key", name: "anthropic" }],
        accounts: [{ type: "api_key", name: "anthropic" }],
      },
    });
    expect(
      await vault.handleSecretRoute({
        method: "POST",
        routeSegments: ["secrets", "read"],
        tenant: TENANT_ONE,
        body: { type: "api_key", name: "anthropic", reveal: true },
      }),
    ).toEqual({
      status: 200,
      body: {
        found: true,
        masked: "sk-ant-ten...-one",
        unreachable: false,
        revealSupported: false,
      },
    });
    expect(
      await vault.handleSecretRoute({
        method: "DELETE",
        routeSegments: ["secrets"],
        tenant: TENANT_ONE,
        body: { type: "api_key", name: "anthropic" },
      }),
    ).toEqual({
      status: 200,
      body: { success: true, type: "api_key", name: "anthropic" },
    });
  });

  test("never includes plaintext provider keys in renderer route responses", async () => {
    const db = setupDb();
    const vault = enabledVault(db);
    const plaintext = "sk-sensitive-tenant-value-1234";
    const responses = [
      await vault.handleSecretRoute({
        method: "POST",
        routeSegments: ["secrets"],
        tenant: TENANT_ONE,
        body: {
          type: "api_key",
          name: "openai",
          value: plaintext,
        },
      }),
      await vault.handleSecretRoute({
        method: "GET",
        routeSegments: ["secrets"],
        tenant: TENANT_ONE,
      }),
      await vault.handleSecretRoute({
        method: "POST",
        routeSegments: ["secrets", "read"],
        tenant: TENANT_ONE,
        body: { type: "api_key", name: "openai", reveal: false },
      }),
      await vault.handleSecretRoute({
        method: "POST",
        routeSegments: ["secrets", "read"],
        tenant: TENANT_ONE,
        body: { type: "api_key", name: "openai", reveal: true },
      }),
      await vault.handleSecretRoute({
        method: "DELETE",
        routeSegments: ["secrets"],
        tenant: TENANT_ONE,
        body: { type: "api_key", name: "openai" },
      }),
    ];

    for (const response of responses) {
      expect(JSON.stringify(response.body)).not.toContain(plaintext);
    }
    expect(responses[3]).toMatchObject({
      status: 200,
      body: {
        found: true,
        masked: "sk-sensiti...1234",
        revealSupported: false,
      },
    });
  });

  test("resolves only while the exact request, tenant, lease, and generation are active", () => {
    const db = setupDb();
    const vault = enabledVault(db);
    vault.set(TENANT_ONE, "openai", "sk-tenant-one", NOW_ISO);
    vault.set(TENANT_TWO, "openai", "sk-tenant-two", NOW_ISO);
    claim(db);
    const capability = vault.mintRequestCapability(
      TENANT_ONE,
      activeBinding(db),
      "request-1",
      1_001,
    );

    expect(vault.resolveWithCapability(capability, "openai", 1_002)).toEqual({
      ok: true,
      tenant: TENANT_ONE,
      provider: "openai",
      value: "sk-tenant-one",
    });
    expect(vault.revokeRequestCapability("request-1")).toBe(true);
    expect(vault.resolveWithCapability(capability, "openai", 1_003)).toEqual({
      ok: false,
      reason: "inactive_request",
    });
  });

  test("revokes every in-process capability when coordinator ownership is fenced", () => {
    const db = setupDb();
    const vault = enabledVault(db);
    vault.set(TENANT_ONE, "openai", "sk-tenant-one", NOW_ISO);
    claim(db);
    const binding = activeBinding(db);
    const first = vault.mintRequestCapability(
      TENANT_ONE,
      binding,
      "request-fenced-1",
      1_001,
    );
    const second = vault.mintRequestCapability(
      TENANT_ONE,
      binding,
      "request-fenced-2",
      1_001,
    );

    expect(vault.revokeAllRequestCapabilities()).toBe(2);
    for (const capability of [first, second]) {
      expect(vault.resolveWithCapability(capability, "openai", 1_002)).toEqual({
        ok: false,
        reason: "inactive_request",
      });
    }
    expect(vault.revokeAllRequestCapabilities()).toBe(0);
  });

  test("remains usable past the initial lease expiry only while that lease is renewed", () => {
    const db = setupDb();
    const vault = enabledVault(db);
    vault.set(TENANT_ONE, "openai", "sk-tenant-one", NOW_ISO);
    claim(db, TENANT_ONE, 1_000);
    const initial = activeBinding(db, 1_001);
    expect(() =>
      vault.mintRequestCapability(
        TENANT_ONE,
        { ...initial, leaseExpiresAtMs: 1_001 },
        "request-expired-at-mint",
        1_001,
      ),
    ).toThrow("capability lease is invalid");
    const capability = vault.mintRequestCapability(
      TENANT_ONE,
      initial,
      "request-renewed",
      1_001,
    );
    const claims = JSON.parse(
      Buffer.from(capability.split(".")[1]!, "base64url").toString("utf8"),
    ) as { exp: number };

    expect(initial.leaseExpiresAtMs).toBe(61_000);
    expect(claims.exp).toBe(
      Math.floor(1_001 / 1_000) + POOLED_MODEL_KEY_CAPABILITY_TTL_SECONDS,
    );
    renewRuntimeWorkerLease(
      db,
      { id: TENANT_ONE.assistantId, org_id: TENANT_ONE.organizationId },
      "lease-asst-1",
      50_000,
      60_000,
      () => NOW_ISO,
    );

    expect(vault.resolveWithCapability(capability, "openai", 70_000)).toEqual({
      ok: true,
      tenant: TENANT_ONE,
      provider: "openai",
      value: "sk-tenant-one",
    });
    expect(vault.revokeRequestCapability("request-renewed")).toBe(true);
    expect(vault.resolveWithCapability(capability, "openai", 70_001)).toEqual({
      ok: false,
      reason: "inactive_request",
    });
  });

  test("fails closed past the initial lease expiry when renewal stops", () => {
    const db = setupDb();
    const vault = enabledVault(db);
    vault.set(TENANT_ONE, "openai", "sk-tenant-one", NOW_ISO);
    claim(db, TENANT_ONE, 1_000);
    const capability = vault.mintRequestCapability(
      TENANT_ONE,
      activeBinding(db, 1_001),
      "request-unrenewed",
      1_001,
    );

    expect(vault.resolveWithCapability(capability, "openai", 70_000)).toEqual({
      ok: false,
      reason: "inactive_lease",
    });
  });

  test("rejects tampering, expiry, and stale lease generations", () => {
    const db = setupDb();
    const vault = enabledVault(db);
    claim(db);
    const first = vault.mintRequestCapability(
      TENANT_ONE,
      activeBinding(db),
      "request-first",
      1_001,
    );
    const parts = first.split(".");
    const tamperedClaims = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    tamperedClaims.organization_id = "org-2";
    const tampered = `${parts[0]}.${Buffer.from(
      JSON.stringify(tamperedClaims),
    ).toString("base64url")}.${parts[2]}`;
    expect(vault.resolveWithCapability(tampered, "openai", 1_002)).toEqual({
      ok: false,
      reason: "invalid_capability",
    });

    releaseRuntimeWorkerLease(
      db,
      { id: TENANT_ONE.assistantId, org_id: TENANT_ONE.organizationId },
      "lease-asst-1",
      1_100,
      () => NOW_ISO,
    );
    markRuntimeWorkerSanitized(
      db,
      "worker-1",
      { id: TENANT_ONE.assistantId, org_id: TENANT_ONE.organizationId },
      1_101,
      () => NOW_ISO,
    );
    claim(db, TENANT_TWO, 1_102);
    expect(vault.resolveWithCapability(first, "openai", 1_103)).toEqual({
      ok: false,
      reason: "stale_lease_generation",
    });
    expect(
      vault.resolveWithCapability(
        first,
        "openai",
        (POOLED_MODEL_KEY_CAPABILITY_TTL_SECONDS + 2) * 1_000,
      ),
    ).toEqual({
      ok: false,
      reason: "expired_capability",
    });
  });
});
