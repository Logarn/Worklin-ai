import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  acceptArtifactInvitation,
  createArtifactInvitation,
  ensureArtifactSharingSchema,
} from "./artifact-sharing-store.js";
import {
  claimAssistantRetirementLease,
  confirmAssistantRetirementResourceCleanup,
  ensureAssistantRetirementSchema,
  finalizeAssistantRetirement,
  getAssistantRetirement,
  releaseAssistantRetirementLease,
  renewAssistantRetirementLease,
  suspendAssistantForRetirement,
} from "./assistant-retirement-store.js";
import {
  ensureAssistantStoreSchema,
  type AssistantRow,
} from "./assistant-store.js";
import {
  createOrGetBrandResearchRun,
  ensureBrandResearchRunSchema,
} from "./brand-research-runs.js";
import {
  claimRuntimeServiceProvisioningLease,
  countAllocatedRuntimeServices,
  ensureRuntimeStackForAssistant,
  ensureRuntimeStackSchema,
  getRuntimeStackById,
  markRuntimeStackActive,
  recordRuntimeStackService,
  recordRuntimeStackVolume,
  releaseRuntimeServiceProvisioningLease,
  type RuntimeStackConfig,
} from "./runtime-stacks.js";
import {
  assignAssistant,
  ensureWorkspaceManagementSchema,
} from "./workspace-management-store.js";

const NOW = () => "2026-07-22T12:00:00.000Z";

function setupDb(): { db: Database; assistant: AssistantRow } {
  const db = new Database(":memory:");
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO users (
      id, email, username, first_name, last_name, consent_json, created_at,
      updated_at
    ) VALUES (
      'user-1', 'user@example.com', 'user-1', '', '', NULL,
      '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z'
    );
    INSERT INTO organizations (id, user_id, name, created_at, updated_at)
    VALUES (
      'org-1', 'user-1', 'Workspace', '2026-07-22T00:00:00.000Z',
      '2026-07-22T00:00:00.000Z'
    );
    INSERT INTO assistants (id, user_id, org_id, name, created_at, updated_at)
    VALUES (
      'assistant-1', 'user-1', 'org-1', 'Worklin',
      '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z'
    );
  `);
  ensureArtifactSharingSchema(db);
  ensureAssistantStoreSchema(db);
  ensureRuntimeStackSchema(db);
  ensureBrandResearchRunSchema(db);
  ensureWorkspaceManagementSchema(db);
  ensureAssistantRetirementSchema(db);
  const assistant = db
    .query<AssistantRow, [string]>("SELECT * FROM assistants WHERE id = ?")
    .get("assistant-1")!;
  return { db, assistant };
}

function runtimeConfig(): RuntimeStackConfig {
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
    preprovisionedRuntimeSlots: [],
  };
}

function activeStack(db: Database, assistant: AssistantRow) {
  const stack = ensureRuntimeStackForAssistant(
    db,
    assistant,
    runtimeConfig(),
    NOW,
  );
  recordRuntimeStackService(db, stack.id, "service-1", NOW);
  recordRuntimeStackVolume(db, stack.id, "volume-1", NOW);
  markRuntimeStackActive(
    db,
    stack.id,
    "http://runtime.railway.internal:8080",
    "200",
    NOW,
  );
  return getRuntimeStackById(db, stack.id)!;
}

function seedAssistantScopedRows(db: Database, assistant: AssistantRow): void {
  assignAssistant(db, assistant.org_id, assistant.id, assistant.user_id, NOW);
  const invitation = createArtifactInvitation(db, {
    assistant_id: assistant.id,
    artifact_id: "artifact-1",
    email_normalized: "recipient@example.com",
    role: "viewer",
    token_hash: "token-hash-1",
    expires_at: 2_000_000_000,
    created_by_user_id: assistant.user_id,
    created_at: NOW(),
  });
  acceptArtifactInvitation(db, invitation, "recipient-1", NOW());
  createOrGetBrandResearchRun(
    db,
    {
      orgId: assistant.org_id,
      userId: assistant.user_id,
      assistantId: assistant.id,
      brandName: "Example Brand",
    },
    NOW,
  );
}

describe("assistant retirement persistence", () => {
  test("blocks routing immediately and frees capacity only after transactional cleanup", () => {
    const { db, assistant } = setupDb();
    const stack = activeStack(db, assistant);
    seedAssistantScopedRows(db, assistant);

    const retirement = suspendAssistantForRetirement(
      db,
      assistant,
      stack,
      assistant.user_id,
      NOW,
    );
    expect(getRuntimeStackById(db, stack.id)).toMatchObject({
      status: "suspended",
      gateway_url: null,
      public_ingress_url: null,
      service_ref: "service-1",
      workspace_volume_ref: "volume-1",
    });
    expect(retirement).toMatchObject({
      service_cleanup_confirmed: 0,
      volume_cleanup_confirmed: 0,
    });
    expect(countAllocatedRuntimeServices(db)).toBe(1);

    const claim = claimAssistantRetirementLease(
      db,
      stack.id,
      "retirement-lease",
      1_000,
      5_000,
      NOW,
    );
    expect(claim.leaseAcquired).toBe(true);
    confirmAssistantRetirementResourceCleanup(
      db,
      stack.id,
      "volume",
      "retirement-lease",
      NOW,
    );
    expect(() =>
      finalizeAssistantRetirement(
        db,
        stack.id,
        "retirement-lease",
        NOW,
      ),
    ).toThrow("cleanup is not confirmed");
    expect(countAllocatedRuntimeServices(db)).toBe(1);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM assistants",
        )
        .get()?.count,
    ).toBe(1);

    confirmAssistantRetirementResourceCleanup(
      db,
      stack.id,
      "service",
      "retirement-lease",
      NOW,
    );
    finalizeAssistantRetirement(db, stack.id, "retirement-lease", NOW);

    expect(countAllocatedRuntimeServices(db)).toBe(0);
    expect(getRuntimeStackById(db, stack.id)).toMatchObject({
      status: "deleted",
      gateway_url: null,
      service_ref: "service-1",
      workspace_volume_ref: "volume-1",
      service_capacity_reserved: 0,
      provisioning_lease_token: null,
    });
    expect(getAssistantRetirement(db, stack.id)).toMatchObject({
      assistant_id: assistant.id,
      org_id: assistant.org_id,
      owner_user_id: assistant.user_id,
      requested_by_user_id: assistant.user_id,
      provider: "railway",
      service_ref: "service-1",
      workspace_volume_ref: "volume-1",
      service_cleanup_confirmed: 1,
      volume_cleanup_confirmed: 1,
      final_status: "completed",
      completed_at: NOW(),
      lease_token: null,
      lease_expires_at: null,
      last_error: null,
    });
    for (const table of [
      "assistants",
      "assistant_assignments",
      "artifact_invitations",
      "artifact_grants",
      "brand_research_runs",
    ]) {
      expect(
        db
          .query<
            { count: number },
            []
          >(`SELECT COUNT(*) AS count FROM ${table}`)
          .get()?.count,
      ).toBe(0);
    }
  });

  test("serializes retirement behind provisioning and concurrent retire requests", () => {
    const { db, assistant } = setupDb();
    const stack = ensureRuntimeStackForAssistant(
      db,
      assistant,
      runtimeConfig(),
      NOW,
    );
    const provisioning = claimRuntimeServiceProvisioningLease(
      db,
      stack.id,
      1,
      "provisioning-lease",
      1_000,
      5_000,
      NOW,
    );
    expect(provisioning.leaseAcquired).toBe(true);
    suspendAssistantForRetirement(
      db,
      assistant,
      provisioning.stack!,
      assistant.user_id,
      NOW,
    );

    expect(
      claimAssistantRetirementLease(
        db,
        stack.id,
        "retirement-first",
        2_000,
        5_000,
        NOW,
      ),
    ).toMatchObject({
      leaseAcquired: false,
      blockedBy: "provisioning",
      retryAfterMs: 4_000,
    });
    releaseRuntimeServiceProvisioningLease(
      db,
      stack.id,
      "provisioning-lease",
      NOW,
    );

    expect(
      claimAssistantRetirementLease(
        db,
        stack.id,
        "retirement-first",
        2_100,
        5_000,
        NOW,
      ).leaseAcquired,
    ).toBe(true);
    expect(
      claimAssistantRetirementLease(
        db,
        stack.id,
        "retirement-second",
        2_200,
        5_000,
        NOW,
      ),
    ).toMatchObject({
      leaseAcquired: false,
      blockedBy: "retirement",
    });

    releaseAssistantRetirementLease(
      db,
      stack.id,
      "retirement-first",
      NOW,
    );
    expect(
      claimAssistantRetirementLease(
        db,
        stack.id,
        "retirement-second",
        2_300,
        5_000,
        NOW,
      ).leaseAcquired,
    ).toBe(true);
    expect(() =>
      renewAssistantRetirementLease(
        db,
        stack.id,
        "retirement-second",
        7_300,
        5_000,
        NOW,
      ),
    ).toThrow("lease was lost");
  });

  test("rolls back assistant deletion and capacity release when finalization fails", () => {
    const { db, assistant } = setupDb();
    const stack = activeStack(db, assistant);
    seedAssistantScopedRows(db, assistant);
    suspendAssistantForRetirement(
      db,
      assistant,
      stack,
      assistant.user_id,
      NOW,
    );
    expect(
      claimAssistantRetirementLease(
        db,
        stack.id,
        "retirement-lease",
        1_000,
        5_000,
        NOW,
      ).leaseAcquired,
    ).toBe(true);
    confirmAssistantRetirementResourceCleanup(
      db,
      stack.id,
      "volume",
      "retirement-lease",
      NOW,
    );
    confirmAssistantRetirementResourceCleanup(
      db,
      stack.id,
      "service",
      "retirement-lease",
      NOW,
    );
    db.exec(`
      CREATE TRIGGER reject_runtime_deletion
      BEFORE UPDATE OF status ON runtime_stacks
      WHEN NEW.status = 'deleted'
      BEGIN
        SELECT RAISE(ABORT, 'injected finalization failure');
      END;
    `);

    expect(() =>
      finalizeAssistantRetirement(
        db,
        stack.id,
        "retirement-lease",
        NOW,
      ),
    ).toThrow("injected finalization failure");

    expect(countAllocatedRuntimeServices(db)).toBe(1);
    expect(getRuntimeStackById(db, stack.id)?.status).toBe("suspended");
    expect(getAssistantRetirement(db, stack.id)).toMatchObject({
      final_status: "pending",
      service_cleanup_confirmed: 1,
      volume_cleanup_confirmed: 1,
      lease_token: "retirement-lease",
    });
    for (const table of [
      "assistants",
      "assistant_assignments",
      "artifact_invitations",
      "artifact_grants",
      "brand_research_runs",
    ]) {
      expect(
        db
          .query<
            { count: number },
            []
          >(`SELECT COUNT(*) AS count FROM ${table}`)
          .get()?.count,
      ).toBe(1);
    }
  });
});
