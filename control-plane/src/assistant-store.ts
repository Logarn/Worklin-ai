import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export interface OrganizationRow {
  id: string;
  user_id: string;
  name: string;
}

export interface AssistantRow {
  id: string;
  user_id: string;
  org_id: string;
  name: string;
  runtime_stack_id: string | null;
  isolation_version: number;
  created_at: string;
  updated_at: string;
}

export function hasAcceptedAssistantConsent(
  consentJson: string | null,
): boolean {
  if (!consentJson) return false;
  try {
    const consent = JSON.parse(consentJson) as Record<string, unknown>;
    return (
      typeof consent.tos_accepted_version === "string" &&
      consent.tos_accepted_version.length > 0 &&
      typeof consent.privacy_policy_accepted_version === "string" &&
      consent.privacy_policy_accepted_version.length > 0 &&
      typeof consent.ai_data_sharing_accepted_version === "string" &&
      consent.ai_data_sharing_accepted_version.length > 0
    );
  } catch {
    return false;
  }
}

export function getOrCreateOrganization(
  db: Database,
  userId: string,
  nowIso: () => string,
): OrganizationRow {
  const existing = db
    .query<OrganizationRow, [string]>(
      "SELECT * FROM organizations WHERE user_id = ? ORDER BY created_at LIMIT 1",
    )
    .get(userId);
  if (existing) return existing;

  const timestamp = nowIso();
  const organization: OrganizationRow = {
    id: randomUUID(),
    user_id: userId,
    name: "Worklin Workspace",
  };
  db.query(
    "INSERT INTO organizations (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    organization.id,
    organization.user_id,
    organization.name,
    timestamp,
    timestamp,
  );
  return organization;
}

export function getActiveAssistant(
  db: Database,
  userId: string,
): AssistantRow | null {
  return db
    .query<AssistantRow, [string]>(
      "SELECT * FROM assistants WHERE user_id = ? ORDER BY created_at LIMIT 1",
    )
    .get(userId);
}

export function getOrCreateAssistant(
  db: Database,
  userId: string,
  nowIso: () => string,
): AssistantRow {
  const existing = getActiveAssistant(db, userId);
  if (existing) return existing;

  const organization = getOrCreateOrganization(db, userId, nowIso);
  const timestamp = nowIso();
  const assistant: AssistantRow = {
    id: `worklin-${randomUUID()}`,
    user_id: userId,
    org_id: organization.id,
    name: "Worklin",
    runtime_stack_id: null,
    isolation_version: 2,
    created_at: timestamp,
    updated_at: timestamp,
  };
  db.query(`
    INSERT INTO assistants (
      id,
      user_id,
      org_id,
      name,
      runtime_stack_id,
      isolation_version,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    assistant.id,
    assistant.user_id,
    assistant.org_id,
    assistant.name,
    assistant.runtime_stack_id,
    assistant.isolation_version,
    assistant.created_at,
    assistant.updated_at,
  );
  return assistant;
}
