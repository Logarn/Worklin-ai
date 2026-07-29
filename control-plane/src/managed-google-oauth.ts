import type { Database } from "bun:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

type EnvLike = Record<string, string | undefined>;
type FetchLike = typeof fetch;

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const MAX_PROXY_RESPONSE_BYTES = 20 * 1024 * 1024;
const SERVICE_KEY_CONTEXT = "worklin/managed-oauth/runtime-service-key/v1";
const ENCRYPTION_CONTEXT = "worklin/managed-oauth/ciphertext/v1";

export const DEFAULT_GOOGLE_OAUTH_SCOPES = Object.freeze([
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/contacts.readonly",
]);

const GOOGLE_PROXY_ORIGINS = new Set([
  "https://gmail.googleapis.com",
  "https://www.googleapis.com",
  "https://people.googleapis.com",
]);

const FORWARDED_RESPONSE_HEADERS = new Set([
  "content-type",
  "etag",
  "last-modified",
  "location",
  "retry-after",
  "x-goog-upload-url",
  "x-goog-upload-status",
]);

const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "range",
  "x-goog-content-length-range",
  "x-upload-content-length",
  "x-upload-content-type",
]);

export interface ManagedGoogleOAuthConfig {
  enabled: boolean;
  clientId: string;
  clientCredential: string;
  publicBaseUrl: string;
  callbackUrl: string;
  encryptionKey: Buffer | null;
  scopes: readonly string[];
}

export interface ManagedOAuthTenant {
  assistantId: string;
  organizationId: string;
  userId: string;
}

export interface ManagedOAuthConnectionPayload {
  id: string;
  provider: "google";
  status: "ACTIVE" | "REVOKED" | "ERROR";
  connected: boolean;
  account_label: string | null;
  scopes_granted: string[];
  expires_at: string | null;
}

interface OAuthStateRow {
  state_hash: string;
  assistant_id: string;
  org_id: string;
  user_id: string;
  provider: string;
  code_verifier_ciphertext: string;
  requested_scopes_json: string;
  redirect_after_connect: string;
  expires_at_ms: number;
}

interface OAuthConnectionRow {
  id: string;
  assistant_id: string;
  org_id: string;
  user_id: string;
  provider: string;
  account_identifier: string;
  account_label: string | null;
  status: "ACTIVE" | "REVOKED" | "ERROR";
  scopes_json: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string | null;
  expires_at_ms: number | null;
  created_at: string;
  updated_at: string;
}

interface GoogleTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
  token_type?: unknown;
}

interface GoogleUserInfo {
  id?: unknown;
  email?: unknown;
  verified_email?: unknown;
}

export interface ManagedOAuthProxyRequest {
  request?: {
    method?: unknown;
    path?: unknown;
    query?: unknown;
    headers?: unknown;
    body?: unknown;
    base_url?: unknown;
  };
}

export type ManagedOAuthProxyResult =
  | {
      ok: true;
      status: number;
      headers: Record<string, string>;
      body: unknown;
    }
  | {
      ok: false;
      status: 400 | 401 | 403 | 404 | 424 | 502;
      detail: string;
    };

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseScopes(value: string | undefined): readonly string[] {
  if (!value?.trim()) return DEFAULT_GOOGLE_OAUTH_SCOPES;
  const scopes = value
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  return scopes.length > 0 ? Object.freeze([...new Set(scopes)]) : [];
}

function parsePublicBaseUrl(rawEnv: EnvLike): string {
  const value =
    rawEnv.WORKLIN_PUBLIC_PLATFORM_URL?.trim() ||
    rawEnv.WORKLIN_WEB_ORIGIN?.trim() ||
    "https://worklin-ai.vercel.app";
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "127.0.0.1"
    ) {
      return "";
    }
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return trimTrailingSlash(parsed.toString());
  } catch {
    return "";
  }
}

export function managedGoogleOAuthConfigFromEnv(
  rawEnv: EnvLike,
): ManagedGoogleOAuthConfig {
  const clientId = rawEnv.WORKLIN_GOOGLE_OAUTH_CLIENT_ID?.trim() || "";
  const clientCredential =
    rawEnv.WORKLIN_GOOGLE_OAUTH_CLIENT_CREDENTIAL?.trim() || "";
  const publicBaseUrl = parsePublicBaseUrl(rawEnv);
  const rawEncryptionKey =
    rawEnv.WORKLIN_OAUTH_TOKEN_ENCRYPTION_KEY?.trim() || "";
  const encryptionKey = /^[0-9a-f]{64}$/iu.test(rawEncryptionKey)
    ? Buffer.from(rawEncryptionKey, "hex")
    : null;
  const scopes = parseScopes(rawEnv.WORKLIN_GOOGLE_OAUTH_SCOPES);
  return Object.freeze({
    enabled:
      !!clientId &&
      !!clientCredential &&
      !!publicBaseUrl &&
      encryptionKey !== null &&
      scopes.length > 0,
    clientId,
    clientCredential,
    publicBaseUrl,
    callbackUrl: publicBaseUrl
      ? `${publicBaseUrl}/v1/oauth/google/callback/`
      : "",
    encryptionKey,
    scopes,
  });
}

export function managedGoogleOAuthConfigurationError(
  config: ManagedGoogleOAuthConfig,
): string | null {
  if (!config.clientId) return "Google OAuth client ID is not configured.";
  if (!config.clientCredential) {
    return "Google OAuth private client credential is not configured.";
  }
  if (!config.publicBaseUrl) {
    return "Worklin's public OAuth address is invalid.";
  }
  if (!config.encryptionKey) {
    return "OAuth token encryption is not configured.";
  }
  if (config.scopes.length === 0) {
    return "Google OAuth scopes are not configured.";
  }
  return null;
}

export function deriveManagedOAuthServiceKey(
  runtimeActorSigningKey: string,
  assistantId: string,
): string {
  if (!/^[0-9a-f]{64}$/iu.test(runtimeActorSigningKey)) {
    throw new Error(
      "Runtime actor signing key must be 64 hexadecimal characters.",
    );
  }
  const normalizedAssistantId = assistantId.trim();
  if (
    !normalizedAssistantId ||
    normalizedAssistantId.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(normalizedAssistantId)
  ) {
    throw new Error("Assistant ID is invalid.");
  }
  return createHmac("sha256", Buffer.from(runtimeActorSigningKey, "hex"))
    .update(`${SERVICE_KEY_CONTEXT}\0${normalizedAssistantId}`)
    .digest("hex");
}

export function serviceKeyMatches(
  presented: string,
  expected: string,
): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function encryptionAad(
  tenant: ManagedOAuthTenant,
  provider: string,
  purpose: string,
): Buffer {
  return Buffer.from(
    [
      ENCRYPTION_CONTEXT,
      tenant.organizationId,
      tenant.userId,
      tenant.assistantId,
      provider,
      purpose,
    ].join("\0"),
  );
}

function encryptValue(value: string, key: Buffer, aad: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function decryptValue(value: string, key: Buffer, aad: Buffer): string {
  const [ivText, tagText, ciphertextText] = value.split(".");
  if (!ivText || !tagText || !ciphertextText) {
    throw new Error("Stored OAuth credential is invalid.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function connectionPayload(
  row: OAuthConnectionRow,
): ManagedOAuthConnectionPayload {
  return {
    id: row.id,
    provider: "google",
    status: row.status,
    connected: row.status === "ACTIVE",
    account_label: row.account_label,
    scopes_granted: parseStringArray(row.scopes_json),
    expires_at:
      row.expires_at_ms === null
        ? null
        : new Date(row.expires_at_ms).toISOString(),
  };
}

function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function safeRedirectAfterConnect(
  value: string,
  publicBaseUrl: string,
): string | null {
  try {
    const redirect = new URL(value);
    const base = new URL(publicBaseUrl);
    if (
      redirect.origin !== base.origin ||
      redirect.pathname !== "/account/oauth/popup-complete"
    ) {
      return null;
    }
    redirect.hash = "";
    return redirect.toString();
  } catch {
    return null;
  }
}

function callbackRedirect(
  value: string,
  provider: string,
  status: "connected" | "denied",
  code?: string,
): string {
  const redirect = new URL(value);
  redirect.searchParams.set("oauth_status", status);
  redirect.searchParams.set("oauth_provider", provider);
  redirect.searchParams.delete("oauth_pending");
  if (code) redirect.searchParams.set("oauth_code", code);
  else redirect.searchParams.delete("oauth_code");
  return redirect.toString();
}

function strictPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function contentBody(text: string, contentType: string | null): unknown {
  if (!text) return null;
  if (contentType?.toLowerCase().includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function requestUrl(
  baseUrlValue: unknown,
  pathValue: unknown,
  queryValue: unknown,
): URL | null {
  if (typeof baseUrlValue !== "string" || typeof pathValue !== "string") {
    return null;
  }
  let base: URL;
  try {
    base = new URL(baseUrlValue);
  } catch {
    return null;
  }
  if (
    !GOOGLE_PROXY_ORIGINS.has(base.origin) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    return null;
  }
  if (!pathValue.startsWith("/") || pathValue.startsWith("//")) return null;
  let url: URL;
  try {
    url = new URL(`${trimTrailingSlash(base.toString())}${pathValue}`);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;
  if (
    queryValue &&
    typeof queryValue === "object" &&
    !Array.isArray(queryValue)
  ) {
    for (const [key, raw] of Object.entries(
      queryValue as Record<string, unknown>,
    )) {
      if (!key || /[\u0000-\u001f\u007f]/u.test(key)) continue;
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) {
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          url.searchParams.append(key, String(value));
        }
      }
    }
  }
  return url;
}

function sanitizedRequestHeaders(value: unknown, accessToken: string): Headers {
  const headers = new Headers();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (
        FORWARDED_REQUEST_HEADERS.has(key.toLowerCase()) &&
        typeof raw === "string"
      ) {
        headers.set(key, raw);
      }
    }
  }
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}

function sanitizedResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (FORWARDED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      result[key.toLowerCase()] = value;
    }
  }
  return result;
}

function requestBody(
  method: string,
  value: unknown,
  headers: Headers,
): BodyInit | undefined {
  if (
    method === "GET" ||
    method === "HEAD" ||
    value === null ||
    value === undefined
  ) {
    return undefined;
  }
  if (
    typeof value === "string" ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return value as BodyInit;
  }
  if (!headers.has("content-type")) {
    headers.set("Content-Type", "application/json");
  }
  return JSON.stringify(value);
}

async function limitedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_PROXY_RESPONSE_BYTES
  ) {
    throw new Error("Google response is too large.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PROXY_RESPONSE_BYTES) {
    throw new Error("Google response is too large.");
  }
  return new TextDecoder().decode(bytes);
}

export class ManagedGoogleOAuthService {
  constructor(
    private readonly db: Database,
    readonly config: ManagedGoogleOAuthConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS managed_oauth_states (
        state_hash TEXT PRIMARY KEY,
        assistant_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        code_verifier_ciphertext TEXT NOT NULL,
        requested_scopes_json TEXT NOT NULL,
        redirect_after_connect TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS managed_oauth_connections (
        id TEXT PRIMARY KEY,
        assistant_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        account_identifier TEXT NOT NULL,
        account_label TEXT,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'REVOKED', 'ERROR')),
        scopes_json TEXT NOT NULL,
        access_token_ciphertext TEXT NOT NULL,
        refresh_token_ciphertext TEXT,
        expires_at_ms INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(assistant_id, user_id, provider, account_identifier)
      );
      CREATE INDEX IF NOT EXISTS idx_managed_oauth_connections_assistant
        ON managed_oauth_connections (assistant_id, provider, status);
      CREATE INDEX IF NOT EXISTS idx_managed_oauth_states_expiry
        ON managed_oauth_states (expires_at_ms);
    `);
  }

  private requireEncryptionKey(): Buffer {
    if (!this.config.encryptionKey) {
      throw new Error("OAuth token encryption is unavailable.");
    }
    return this.config.encryptionKey;
  }

  configurationError(): string | null {
    return managedGoogleOAuthConfigurationError(this.config);
  }

  start(input: {
    tenant: ManagedOAuthTenant;
    redirectAfterConnect: string;
    requestedScopes?: readonly string[];
  }): {
    success: true;
    deferred: false;
    provider: "google";
    connect_url: string;
    state_id: string;
  } {
    const configurationError = this.configurationError();
    if (configurationError) throw new Error(configurationError);
    const redirect = safeRedirectAfterConnect(
      input.redirectAfterConnect,
      this.config.publicBaseUrl,
    );
    if (!redirect) {
      throw new Error("The OAuth completion address is not allowed.");
    }
    const allowedScopes = new Set(this.config.scopes);
    const requested =
      input.requestedScopes && input.requestedScopes.length > 0
        ? [...new Set(input.requestedScopes.map((scope) => scope.trim()))]
        : [...this.config.scopes];
    if (
      requested.length === 0 ||
      requested.some((scope) => !scope || !allowedScopes.has(scope))
    ) {
      throw new Error(
        "One or more requested Google permissions are not allowed.",
      );
    }

    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const timestamp = this.now();
    const tenant = input.tenant;
    const key = this.requireEncryptionKey();
    this.db
      .query(
        `DELETE FROM managed_oauth_states
         WHERE expires_at_ms <= ? OR
           (assistant_id = ? AND user_id = ? AND provider = 'google')`,
      )
      .run(timestamp, tenant.assistantId, tenant.userId);
    this.db
      .query(
        `INSERT INTO managed_oauth_states (
           state_hash, assistant_id, org_id, user_id, provider,
           code_verifier_ciphertext, requested_scopes_json,
           redirect_after_connect, expires_at_ms, created_at
         ) VALUES (?, ?, ?, ?, 'google', ?, ?, ?, ?, ?)`,
      )
      .run(
        hashState(state),
        tenant.assistantId,
        tenant.organizationId,
        tenant.userId,
        encryptValue(
          verifier,
          key,
          encryptionAad(tenant, "google", "state-verifier"),
        ),
        JSON.stringify(requested),
        redirect,
        timestamp + OAUTH_STATE_TTL_MS,
        new Date(timestamp).toISOString(),
      );

    const authorize = new URL(GOOGLE_AUTHORIZE_URL);
    authorize.searchParams.set("client_id", this.config.clientId);
    authorize.searchParams.set("redirect_uri", this.config.callbackUrl);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", requested.join(" "));
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", pkceChallenge(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("access_type", "offline");
    authorize.searchParams.set("prompt", "consent");
    authorize.searchParams.set("include_granted_scopes", "true");

    return {
      success: true,
      deferred: false,
      provider: "google",
      connect_url: authorize.toString(),
      state_id: hashState(state).slice(0, 24),
    };
  }

  private consumeState(state: string): OAuthStateRow | null {
    const stateHash = hashState(state);
    const row = this.db
      .query<OAuthStateRow, [string]>(
        "SELECT * FROM managed_oauth_states WHERE state_hash = ?",
      )
      .get(stateHash);
    if (!row) return null;
    this.db
      .query("DELETE FROM managed_oauth_states WHERE state_hash = ?")
      .run(stateHash);
    if (row.expires_at_ms <= this.now()) return null;
    return row;
  }

  async complete(input: {
    state: string;
    code?: string;
    providerError?: string;
  }): Promise<string | null> {
    const state = this.consumeState(input.state);
    if (!state) return null;
    if (input.providerError || !input.code) {
      return callbackRedirect(
        state.redirect_after_connect,
        "google",
        "denied",
        input.providerError || "authorization_cancelled",
      );
    }

    try {
      const tenant: ManagedOAuthTenant = {
        assistantId: state.assistant_id,
        organizationId: state.org_id,
        userId: state.user_id,
      };
      const key = this.requireEncryptionKey();
      const verifier = decryptValue(
        state.code_verifier_ciphertext,
        key,
        encryptionAad(tenant, "google", "state-verifier"),
      );
      const tokenResponse = await this.fetchImpl(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientCredential,
          code: input.code,
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: this.config.callbackUrl,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!tokenResponse.ok) {
        return callbackRedirect(
          state.redirect_after_connect,
          "google",
          "denied",
          "token_exchange_failed",
        );
      }
      const token = (await tokenResponse.json()) as GoogleTokenResponse;
      const accessToken =
        typeof token.access_token === "string" ? token.access_token : "";
      if (!accessToken) {
        return callbackRedirect(
          state.redirect_after_connect,
          "google",
          "denied",
          "token_missing",
        );
      }
      const userInfoResponse = await this.fetchImpl(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!userInfoResponse.ok) {
        return callbackRedirect(
          state.redirect_after_connect,
          "google",
          "denied",
          "account_lookup_failed",
        );
      }
      const userInfo = (await userInfoResponse.json()) as GoogleUserInfo;
      const email =
        typeof userInfo.email === "string"
          ? userInfo.email.trim().toLowerCase()
          : "";
      if (!email) {
        return callbackRedirect(
          state.redirect_after_connect,
          "google",
          "denied",
          "account_email_missing",
        );
      }
      const configuredScopes = parseStringArray(state.requested_scopes_json);
      const grantedScopes =
        typeof token.scope === "string" && token.scope.trim()
          ? token.scope.trim().split(/\s+/u)
          : configuredScopes;
      const expiresIn = strictPositiveNumber(token.expires_in);
      const expiresAtMs =
        expiresIn === null ? null : this.now() + expiresIn * 1_000;
      const refreshToken =
        typeof token.refresh_token === "string" && token.refresh_token
          ? token.refresh_token
          : null;
      const existing = this.db
        .query<
          Pick<
            OAuthConnectionRow,
            "id" | "refresh_token_ciphertext" | "created_at"
          >,
          [string, string, string, string]
        >(
          `SELECT id, refresh_token_ciphertext, created_at
           FROM managed_oauth_connections
           WHERE assistant_id = ? AND user_id = ? AND provider = ? AND account_identifier = ?`,
        )
        .get(tenant.assistantId, tenant.userId, "google", email);
      const connectionId = existing?.id ?? randomUUID();
      const timestamp = new Date(this.now()).toISOString();
      const refreshCiphertext = refreshToken
        ? encryptValue(
            refreshToken,
            key,
            encryptionAad(tenant, "google", `${connectionId}:refresh-token`),
          )
        : (existing?.refresh_token_ciphertext ?? null);
      this.db
        .query(
          `INSERT INTO managed_oauth_connections (
             id, assistant_id, org_id, user_id, provider, account_identifier,
             account_label, status, scopes_json, access_token_ciphertext,
             refresh_token_ciphertext, expires_at_ms, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'google', ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?)
           ON CONFLICT(assistant_id, user_id, provider, account_identifier)
           DO UPDATE SET
             org_id = excluded.org_id,
             account_label = excluded.account_label,
             status = 'ACTIVE',
             scopes_json = excluded.scopes_json,
             access_token_ciphertext = excluded.access_token_ciphertext,
             refresh_token_ciphertext = COALESCE(
               excluded.refresh_token_ciphertext,
               managed_oauth_connections.refresh_token_ciphertext
             ),
             expires_at_ms = excluded.expires_at_ms,
             updated_at = excluded.updated_at`,
        )
        .run(
          connectionId,
          tenant.assistantId,
          tenant.organizationId,
          tenant.userId,
          email,
          email,
          JSON.stringify([...new Set(grantedScopes)]),
          encryptValue(
            accessToken,
            key,
            encryptionAad(tenant, "google", `${connectionId}:access-token`),
          ),
          refreshCiphertext,
          expiresAtMs,
          existing?.created_at ?? timestamp,
          timestamp,
        );
      return callbackRedirect(
        state.redirect_after_connect,
        "google",
        "connected",
      );
    } catch {
      return callbackRedirect(
        state.redirect_after_connect,
        "google",
        "denied",
        "connection_failed",
      );
    }
  }

  list(input: {
    assistantId: string;
    userId?: string;
    provider?: string | null;
    status?: string | null;
    accountIdentifier?: string | null;
  }): ManagedOAuthConnectionPayload[] {
    if (input.provider && input.provider !== "google") return [];
    const clauses = ["assistant_id = ?"];
    const params: string[] = [input.assistantId];
    if (input.userId) {
      clauses.push("user_id = ?");
      params.push(input.userId);
    }
    if (input.accountIdentifier) {
      clauses.push("account_identifier = ?");
      params.push(input.accountIdentifier.trim().toLowerCase());
    }
    if (input.status && input.status !== "ALL") {
      if (!["ACTIVE", "REVOKED", "ERROR"].includes(input.status)) return [];
      clauses.push("status = ?");
      params.push(input.status);
    } else if (!input.status) {
      clauses.push("status = 'ACTIVE'");
    }
    const rows = this.db
      .query<OAuthConnectionRow, string[]>(
        `SELECT * FROM managed_oauth_connections
         WHERE ${clauses.join(" AND ")}
         ORDER BY updated_at DESC, id`,
      )
      .all(...params);
    return rows.map(connectionPayload);
  }

  private connection(
    assistantId: string,
    connectionId: string,
  ): OAuthConnectionRow | null {
    return this.db
      .query<OAuthConnectionRow, [string, string]>(
        `SELECT * FROM managed_oauth_connections
         WHERE assistant_id = ? AND id = ?`,
      )
      .get(assistantId, connectionId);
  }

  async disconnect(input: {
    tenant: ManagedOAuthTenant;
    connectionId: string;
  }): Promise<boolean> {
    const row = this.connection(input.tenant.assistantId, input.connectionId);
    if (!row || row.user_id !== input.tenant.userId) return false;
    this.db
      .query(
        `UPDATE managed_oauth_connections
         SET status = 'REVOKED', updated_at = ?
         WHERE id = ? AND assistant_id = ? AND user_id = ?`,
      )
      .run(
        new Date(this.now()).toISOString(),
        input.connectionId,
        input.tenant.assistantId,
        input.tenant.userId,
      );
    try {
      const token =
        this.decryptConnectionToken(row, "refresh") ??
        this.decryptConnectionToken(row, "access");
      if (token) {
        await this.fetchImpl(GOOGLE_REVOKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }),
          signal: AbortSignal.timeout(10_000),
        });
      }
    } catch {
      // Local revocation is authoritative. Upstream revocation is best effort.
    }
    return true;
  }

  private tenantForRow(row: OAuthConnectionRow): ManagedOAuthTenant {
    return {
      assistantId: row.assistant_id,
      organizationId: row.org_id,
      userId: row.user_id,
    };
  }

  private decryptConnectionToken(
    row: OAuthConnectionRow,
    kind: "access" | "refresh",
  ): string | null {
    const ciphertext =
      kind === "access"
        ? row.access_token_ciphertext
        : row.refresh_token_ciphertext;
    if (!ciphertext) return null;
    return decryptValue(
      ciphertext,
      this.requireEncryptionKey(),
      encryptionAad(
        this.tenantForRow(row),
        row.provider,
        `${row.id}:${kind}-token`,
      ),
    );
  }

  private async accessToken(row: OAuthConnectionRow): Promise<string | null> {
    if (row.status !== "ACTIVE") return null;
    const current = this.decryptConnectionToken(row, "access");
    if (
      current &&
      (row.expires_at_ms === null ||
        row.expires_at_ms > this.now() + TOKEN_REFRESH_SKEW_MS)
    ) {
      return current;
    }
    const refreshToken = this.decryptConnectionToken(row, "refresh");
    if (!refreshToken) return null;
    const response = await this.fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientCredential,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      if (response.status === 400 || response.status === 401) {
        this.db
          .query(
            `UPDATE managed_oauth_connections
             SET status = 'ERROR', updated_at = ? WHERE id = ?`,
          )
          .run(new Date(this.now()).toISOString(), row.id);
        return null;
      }
      throw new Error("Google token refresh is temporarily unavailable.");
    }
    const token = (await response.json()) as GoogleTokenResponse;
    const accessToken =
      typeof token.access_token === "string" ? token.access_token : "";
    if (!accessToken) return null;
    const expiresIn = strictPositiveNumber(token.expires_in);
    const expiresAtMs =
      expiresIn === null ? null : this.now() + expiresIn * 1_000;
    this.db
      .query(
        `UPDATE managed_oauth_connections
         SET access_token_ciphertext = ?, expires_at_ms = ?,
             status = 'ACTIVE', updated_at = ? WHERE id = ?`,
      )
      .run(
        encryptValue(
          accessToken,
          this.requireEncryptionKey(),
          encryptionAad(
            this.tenantForRow(row),
            row.provider,
            `${row.id}:access-token`,
          ),
        ),
        expiresAtMs,
        new Date(this.now()).toISOString(),
        row.id,
      );
    return accessToken;
  }

  async proxy(
    assistantId: string,
    connectionId: string,
    input: ManagedOAuthProxyRequest,
  ): Promise<ManagedOAuthProxyResult> {
    const row = this.connection(assistantId, connectionId);
    if (!row) {
      return { ok: false, status: 404, detail: "Google connection not found." };
    }
    if (row.status !== "ACTIVE") {
      return {
        ok: false,
        status: 424,
        detail: "The Google account needs to be reconnected.",
      };
    }
    const request = input.request;
    if (!request || typeof request !== "object") {
      return { ok: false, status: 400, detail: "Invalid Google request." };
    }
    const method =
      typeof request.method === "string" ? request.method.toUpperCase() : "";
    if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) {
      return {
        ok: false,
        status: 400,
        detail: "Google request method is not allowed.",
      };
    }
    const url = requestUrl(request.base_url, request.path, request.query);
    if (!url) {
      return {
        ok: false,
        status: 403,
        detail: "Google request address is not allowed.",
      };
    }

    try {
      const token = await this.accessToken(row);
      if (!token) {
        return {
          ok: false,
          status: 424,
          detail: "The Google account needs to be reconnected.",
        };
      }
      const headers = sanitizedRequestHeaders(request.headers, token);
      const body = requestBody(method, request.body, headers);
      const upstream = await this.fetchImpl(url, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      const text = await limitedResponseText(upstream);
      return {
        ok: true,
        status: upstream.status,
        headers: sanitizedResponseHeaders(upstream.headers),
        body: contentBody(text, upstream.headers.get("content-type")),
      };
    } catch {
      return {
        ok: false,
        status: 502,
        detail: "Google is temporarily unavailable.",
      };
    }
  }
}
