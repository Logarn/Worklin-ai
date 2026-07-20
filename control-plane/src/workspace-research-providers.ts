import type { Database } from "bun:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export const WORKSPACE_RESEARCH_PROVIDER_IDS = [
  "meld",
  "instagram",
  "facebook",
  "linkedin",
  "youtube",
] as const;

export type WorkspaceResearchProviderId =
  (typeof WORKSPACE_RESEARCH_PROVIDER_IDS)[number];

export interface WorkspaceResearchProviderRow {
  org_id: string;
  provider_id: WorkspaceResearchProviderId;
  connected_at: string;
  updated_at: string;
}

const initializedDatabases = new WeakSet<Database>();

function encryptionKey(signingKey: string): Buffer {
  return createHash("sha256")
    .update("worklin-workspace-research-provider-v1:")
    .update(signingKey)
    .digest();
}

function encryptCredential(credential: string, signingKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(signingKey), iv);
  const ciphertext = Buffer.concat([
    cipher.update(credential, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function decryptCredential(value: string, signingKey: string): string {
  const [ivText, tagText, ciphertextText] = value.split(".");
  if (!ivText || !tagText || !ciphertextText) {
    throw new Error("Stored research-provider credential is invalid.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(signingKey),
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function isWorkspaceResearchProviderId(
  value: unknown,
): value is WorkspaceResearchProviderId {
  return (
    typeof value === "string" &&
    (WORKSPACE_RESEARCH_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

export function ensureWorkspaceResearchProviderSchema(db: Database): void {
  if (initializedDatabases.has(db)) return;
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS workspace_research_providers (
      org_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      credential_ciphertext TEXT NOT NULL,
      connected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (org_id, provider_id)
    );
  `);
  initializedDatabases.add(db);
}

export function listWorkspaceResearchProviders(
  db: Database,
  orgId: string,
): WorkspaceResearchProviderRow[] {
  ensureWorkspaceResearchProviderSchema(db);
  return db
    .query<WorkspaceResearchProviderRow, [string]>(
      `SELECT org_id, provider_id, connected_at, updated_at
       FROM workspace_research_providers
       WHERE org_id = ? ORDER BY provider_id`,
    )
    .all(orgId);
}

export function saveWorkspaceResearchProviderCredential(
  db: Database,
  input: {
    orgId: string;
    providerId: WorkspaceResearchProviderId;
    credential: string;
  },
  signingKey: string,
  nowIso: () => string,
): WorkspaceResearchProviderRow {
  ensureWorkspaceResearchProviderSchema(db);
  const credential = input.credential.trim();
  if (!credential) throw new Error("A provider credential is required.");
  const timestamp = nowIso();
  db.query(
    `INSERT INTO workspace_research_providers (
       org_id, provider_id, credential_ciphertext, connected_at, updated_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(org_id, provider_id) DO UPDATE SET
       credential_ciphertext = excluded.credential_ciphertext,
       updated_at = excluded.updated_at`,
  ).run(
    input.orgId,
    input.providerId,
    encryptCredential(credential, signingKey),
    timestamp,
    timestamp,
  );
  return {
    org_id: input.orgId,
    provider_id: input.providerId,
    connected_at: timestamp,
    updated_at: timestamp,
  };
}

export function deleteWorkspaceResearchProviderCredential(
  db: Database,
  orgId: string,
  providerId: WorkspaceResearchProviderId,
): boolean {
  ensureWorkspaceResearchProviderSchema(db);
  return (
    db
      .query(
        "DELETE FROM workspace_research_providers WHERE org_id = ? AND provider_id = ?",
      )
      .run(orgId, providerId).changes > 0
  );
}

export function getWorkspaceResearchProviderCredential(
  db: Database,
  orgId: string,
  providerId: WorkspaceResearchProviderId,
  signingKey: string,
): string | null {
  ensureWorkspaceResearchProviderSchema(db);
  const row = db
    .query<{ credential_ciphertext: string }, [string, string]>(
      `SELECT credential_ciphertext
       FROM workspace_research_providers
       WHERE org_id = ? AND provider_id = ?`,
    )
    .get(orgId, providerId);
  return row ? decryptCredential(row.credential_ciphertext, signingKey) : null;
}
