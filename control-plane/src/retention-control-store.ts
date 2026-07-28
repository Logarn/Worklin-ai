import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type {
  RetentionProvider,
  RetentionServiceRole,
} from "./retention-service-auth.js";

const ASSIGNABLE_RETENTION_ROLES = new Set<RetentionServiceRole>([
  "retention_viewer",
  "retention_marketer",
  "retention_campaign_approver",
  "retention_campaign_sender",
]);

export interface RetentionIntegrationBinding {
  id: string;
  org_id: string;
  assistant_id: string;
  created_by_user_id: string;
  provider: RetentionProvider;
  status: "pending" | "active" | "revoked";
  created_at: string;
  updated_at: string;
}

export function ensureRetentionControlSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS retention_access_grants (
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (
        role IN (
          'retention_viewer',
          'retention_marketer',
          'retention_campaign_approver',
          'retention_campaign_sender'
        )
      ),
      granted_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (org_id, user_id, role)
    );
    CREATE INDEX IF NOT EXISTS retention_access_grants_org_user
      ON retention_access_grants (org_id, user_id);

    CREATE TABLE IF NOT EXISTS retention_integration_bindings (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('shopify', 'klaviyo')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS retention_integration_bindings_lookup
      ON retention_integration_bindings (org_id, provider, status);
  `);
}

export function retentionRolesForUser(
  db: Database,
  input: {
    organizationId: string;
    userId: string;
    organizationOwnerId: string;
    workspaceRole: "admin" | "manager" | "collaborator";
  },
): RetentionServiceRole[] {
  if (input.userId === input.organizationOwnerId) {
    return ["retention_owner"];
  }
  const granted = db
    .query<{ role: RetentionServiceRole }, [string, string]>(
      `
        SELECT role
        FROM retention_access_grants
        WHERE org_id = ? AND user_id = ?
        ORDER BY role
      `,
    )
    .all(input.organizationId, input.userId)
    .map((row) => row.role);
  if (granted.length > 0) return granted;
  return input.workspaceRole === "collaborator"
    ? ["retention_viewer"]
    : ["retention_marketer"];
}

export function replaceRetentionAccessGrants(
  db: Database,
  input: {
    organizationId: string;
    userId: string;
    grantedByUserId: string;
    roles: readonly string[];
    nowIso: string;
  },
): RetentionServiceRole[] {
  const roles = [...new Set(input.roles)];
  if (
    roles.some(
      (role) =>
        !ASSIGNABLE_RETENTION_ROLES.has(role as RetentionServiceRole),
    )
  ) {
    throw new Error("Invalid retention access role.");
  }
  db.transaction(() => {
    db.query(
      "DELETE FROM retention_access_grants WHERE org_id = ? AND user_id = ?",
    ).run(input.organizationId, input.userId);
    const insert = db.query(
      `
        INSERT INTO retention_access_grants (
          org_id,
          user_id,
          role,
          granted_by_user_id,
          created_at
        )
        VALUES (?, ?, ?, ?, ?)
      `,
    );
    for (const role of roles) {
      insert.run(
        input.organizationId,
        input.userId,
        role,
        input.grantedByUserId,
        input.nowIso,
      );
    }
  })();
  return roles as RetentionServiceRole[];
}

export function listRetentionAccessGrants(
  db: Database,
  organizationId: string,
): Array<{ userId: string; roles: RetentionServiceRole[] }> {
  const rows = db
    .query<
      { user_id: string; role: RetentionServiceRole },
      [string]
    >(
      `
        SELECT user_id, role
        FROM retention_access_grants
        WHERE org_id = ?
        ORDER BY user_id, role
      `,
    )
    .all(organizationId);
  const grants = new Map<string, RetentionServiceRole[]>();
  for (const row of rows) {
    const roles = grants.get(row.user_id) ?? [];
    roles.push(row.role);
    grants.set(row.user_id, roles);
  }
  return [...grants].map(([userId, roles]) => ({ userId, roles }));
}

export function createRetentionIntegrationBinding(
  db: Database,
  input: {
    organizationId: string;
    assistantId: string;
    userId: string;
    provider: RetentionProvider;
    nowIso: string;
  },
): RetentionIntegrationBinding {
  const binding: RetentionIntegrationBinding = {
    id: randomUUID(),
    org_id: input.organizationId,
    assistant_id: input.assistantId,
    created_by_user_id: input.userId,
    provider: input.provider,
    status: "pending",
    created_at: input.nowIso,
    updated_at: input.nowIso,
  };
  db.query(
    `
      INSERT INTO retention_integration_bindings (
        id,
        org_id,
        assistant_id,
        created_by_user_id,
        provider,
        status,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    binding.id,
    binding.org_id,
    binding.assistant_id,
    binding.created_by_user_id,
    binding.provider,
    binding.status,
    binding.created_at,
    binding.updated_at,
  );
  return binding;
}

export function setRetentionIntegrationBindingStatus(
  db: Database,
  id: string,
  status: "active" | "revoked",
  nowIso: string,
): void {
  db.query(
    `
      UPDATE retention_integration_bindings
      SET status = ?, updated_at = ?
      WHERE id = ?
    `,
  ).run(status, nowIso, id);
}

export function deletePendingRetentionIntegrationBinding(
  db: Database,
  id: string,
): void {
  db.query(
    `
      DELETE FROM retention_integration_bindings
      WHERE id = ? AND status = 'pending'
    `,
  ).run(id);
}

export function getActiveRetentionIntegrationBinding(
  db: Database,
  input: { id: string; provider: RetentionProvider },
): RetentionIntegrationBinding | null {
  return db
    .query<RetentionIntegrationBinding, [string, RetentionProvider]>(
      `
        SELECT *
        FROM retention_integration_bindings
        WHERE id = ? AND provider = ? AND status = 'active'
      `,
    )
    .get(input.id, input.provider);
}

export function listActiveRetentionWakeTargets(
  db: Database,
): Array<{ organizationId: string; assistantId: string }> {
  return db
    .query<
      { org_id: string; assistant_id: string },
      []
    >(
      `
        SELECT org_id, min(assistant_id) AS assistant_id
        FROM retention_integration_bindings
        WHERE status = 'active'
        GROUP BY org_id
        ORDER BY org_id
      `,
    )
    .all()
    .map((row) => ({
      organizationId: row.org_id,
      assistantId: row.assistant_id,
    }));
}

export function retentionIntegrationConnectionPayload(
  upstreamBody: unknown,
  binding: { id: string; provider: RetentionProvider },
): Record<string, unknown> | null {
  if (
    !upstreamBody ||
    typeof upstreamBody !== "object" ||
    Array.isArray(upstreamBody)
  ) {
    return null;
  }
  const payload: Record<string, unknown> = {
    ...(upstreamBody as Record<string, unknown>),
    controlPlaneConnectionId: binding.id,
    webhookPath:
      `/webhooks/retention/${binding.provider}/` +
      encodeURIComponent(binding.id),
  };
  delete payload.webhookRouteToken;
  delete payload.credential;
  delete payload.webhookSecret;
  return payload;
}
