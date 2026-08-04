import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { S3Client } from "bun";
import type { Database } from "bun:sqlite";

type EnvLike = Record<string, string | undefined>;
type S3UrlStyle = "path" | "virtual";
type ArchiveFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

const ARCHIVE_FORMAT = "brand_intelligence_archive_v1";
const DEFAULT_GLOBAL_MAX_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_PER_BRAND_MAX_BYTES = 1536 * 1024 * 1024;
const DEFAULT_MAX_JOB_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ASSET_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_VISUAL_ASSETS = 24;
const DEFAULT_WARNING_PERCENT = 70;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const MAX_ARCHIVE_ATTEMPTS = 5;

export interface BrandIntelligenceArchiveConfig {
  enabled: boolean;
  bucket?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  urlStyle: S3UrlStyle;
  globalMaxBytes: number;
  perBrandMaxBytes: number;
  warningPercent: number;
  maxJobBytes: number;
  maxAssetBytes: number;
  maxVisualAssets: number;
  fetchTimeoutMs: number;
}

export interface BrandIntelligenceArchiveRequest {
  organizationId: string;
  userId: string;
  assistantId: string;
  brandId: string;
  snapshotId: string;
  brandBrain: Record<string, unknown>;
  report: Record<string, unknown>;
  quality: Record<string, unknown> | null;
}

export interface BrandIntelligenceArchiveJobResult {
  jobId: string;
  snapshotId: string;
  status: "disabled" | "queued" | "running" | "complete" | "partial";
  idempotent: boolean;
}

export interface BrandIntelligenceArchiveUsage {
  globalBytes: number;
  brandBytes: number;
  globalMaxBytes: number;
  brandMaxBytes: number;
  warning: boolean;
}

export interface BrandIntelligenceObjectStore {
  put(objectKey: string, body: Uint8Array): Promise<void>;
}

export interface BrandIntelligenceArchiveDependencies {
  objectStore?: BrandIntelligenceObjectStore;
  fetch?: ArchiveFetch;
  resolveHostname?: typeof resolveHostname;
  now?: () => Date;
}

interface ArchiveJobRow {
  id: string;
  organization_id: string;
  user_id: string;
  assistant_id: string;
  brand_id: string;
  snapshot_id: string;
  payload_json: string;
  status: "queued" | "running" | "complete" | "partial" | "failed";
  attempt_count: number;
  next_attempt_at: number;
}

interface StoredObjectRow {
  status: "pending" | "stored" | "failed";
  size_bytes: number;
  object_key: string;
}

interface VisualCandidate {
  id: string;
  title: string;
  kind: string;
  module: string | null;
  sourceUrl: string;
  assetUrl: string;
  observedAt: string | null;
}

interface ArchivedVisual extends VisualCandidate {
  archived: boolean;
  objectKey?: string;
  contentType?: string;
  sizeBytes?: number;
  checksumSha256?: string;
  reason?: string;
}

class ArchiveQuotaError extends Error {
  constructor(readonly code: "global_quota" | "brand_quota") {
    super(
      code === "global_quota"
        ? "The shared brand intelligence archive limit has been reached."
        : "This brand has reached its archive limit.",
    );
    this.name = "ArchiveQuotaError";
  }
}

export function brandIntelligenceArchiveConfigFromEnv(
  env: EnvLike,
): BrandIntelligenceArchiveConfig {
  const enabled = env.WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_ENABLED === "true";
  const globalMaxBytes = positiveInteger(
    "WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_GLOBAL_MAX_BYTES",
    env.WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_GLOBAL_MAX_BYTES,
    DEFAULT_GLOBAL_MAX_BYTES,
  );
  const perBrandMaxBytes = positiveInteger(
    "WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_PER_BRAND_MAX_BYTES",
    env.WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_PER_BRAND_MAX_BYTES,
    DEFAULT_PER_BRAND_MAX_BYTES,
  );
  const warningPercent = boundedInteger(
    "WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_WARNING_PERCENT",
    env.WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_WARNING_PERCENT,
    DEFAULT_WARNING_PERCENT,
    1,
    99,
  );
  const config: BrandIntelligenceArchiveConfig = {
    enabled,
    urlStyle:
      env.WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_S3_URL_STYLE === "path"
        ? "path"
        : "virtual",
    globalMaxBytes,
    perBrandMaxBytes,
    warningPercent,
    maxJobBytes: positiveInteger(
      "WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_MAX_JOB_BYTES",
      env.WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_MAX_JOB_BYTES,
      DEFAULT_MAX_JOB_BYTES,
    ),
    maxAssetBytes: positiveInteger(
      "WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_MAX_ASSET_BYTES",
      env.WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_MAX_ASSET_BYTES,
      DEFAULT_MAX_ASSET_BYTES,
    ),
    maxVisualAssets: boundedInteger(
      "WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_MAX_VISUAL_ASSETS",
      env.WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_MAX_VISUAL_ASSETS,
      DEFAULT_MAX_VISUAL_ASSETS,
      0,
      48,
    ),
    fetchTimeoutMs: positiveInteger(
      "WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_FETCH_TIMEOUT_MS",
      env.WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_FETCH_TIMEOUT_MS,
      DEFAULT_FETCH_TIMEOUT_MS,
    ),
  };
  if (!enabled) return config;
  if (perBrandMaxBytes > globalMaxBytes) {
    throw new Error(
      "The per-brand intelligence archive limit cannot exceed the global limit.",
    );
  }

  const bucket = env.WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_BUCKET?.trim() ?? "";
  const endpoint =
    env.WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_S3_ENDPOINT?.trim() ?? "";
  const region = env.WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_S3_REGION?.trim() ?? "";
  const accessKeyId =
    env.WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_S3_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey =
    env.WORKLIN_BRAND_INTELLIGENCE_ARCHIVE_S3_SECRET_ACCESS_KEY?.trim() ?? "";
  if (!/^[A-Za-z0-9._-]{3,128}$/u.test(bucket)) {
    throw new Error("The brand intelligence archive bucket is invalid.");
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(region)) {
    throw new Error("The brand intelligence archive region is invalid.");
  }
  if (
    !/^[A-Za-z0-9._-]{3,256}$/u.test(accessKeyId) ||
    secretAccessKey.length < 8 ||
    secretAccessKey.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(secretAccessKey)
  ) {
    throw new Error("The brand intelligence archive credentials are invalid.");
  }
  const endpointUrl = parseStorageEndpoint(endpoint);
  if (config.urlStyle === "virtual" && bucket.includes(".")) {
    throw new Error(
      "Virtual-hosted brand intelligence archive buckets must be one DNS label.",
    );
  }
  return {
    ...config,
    bucket,
    endpoint: endpointUrl.href,
    region,
    accessKeyId,
    secretAccessKey,
  };
}

export function ensureBrandIntelligenceArchiveSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brand_intelligence_archive_jobs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      brand_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'queued', 'running', 'complete', 'partial', 'failed'
      )),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
      next_attempt_at INTEGER NOT NULL,
      completed_at TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(organization_id, assistant_id, brand_id, snapshot_id)
    );

    CREATE INDEX IF NOT EXISTS brand_intelligence_archive_jobs_due_idx
      ON brand_intelligence_archive_jobs(status, next_attempt_at, created_at);

    CREATE TABLE IF NOT EXISTS brand_intelligence_archive_objects (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      assistant_id TEXT NOT NULL,
      brand_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      object_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('snapshot', 'visual')),
      content_type TEXT NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
      source_url TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'stored', 'failed')),
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS brand_intelligence_archive_objects_brand_idx
      ON brand_intelligence_archive_objects(
        organization_id, assistant_id, brand_id, status
      );
  `);

  // A restart can interrupt a worker after it claims a job. Requeue it rather
  // than leaving research permanently stuck in a misleading running state.
  db.query(
    `UPDATE brand_intelligence_archive_jobs
     SET status = 'queued', updated_at = created_at
     WHERE status = 'running'`,
  ).run();
  db.query(
    `UPDATE brand_intelligence_archive_objects
     SET status = 'failed', error_code = 'interrupted', updated_at = created_at
     WHERE status = 'pending'`,
  ).run();
}

export function parseBrandIntelligenceArchiveRequest(
  value: unknown,
  maxBytes: number,
): BrandIntelligenceArchiveRequest | null {
  if (!isRecord(value)) return null;
  const organizationId = boundedString(value.organizationId, 64);
  const userId = boundedString(value.userId, 512);
  const assistantId = boundedString(value.assistantId, 256);
  const brandId = boundedString(value.brandId, 256);
  const snapshotId = boundedString(value.snapshotId, 96);
  if (
    !organizationId ||
    !UUID_PATTERN.test(organizationId) ||
    !userId ||
    !assistantId ||
    !brandId ||
    !snapshotId ||
    !/^brand_research_[0-9a-f]{64}$/u.test(snapshotId) ||
    !isRecord(value.brandBrain) ||
    !isRecord(value.report) ||
    (value.quality !== null && !isRecord(value.quality))
  ) {
    return null;
  }
  const reportQuery = isRecord(value.report.query) ? value.report.query : null;
  if (!reportQuery || !boundedString(reportQuery.brandName, 512)) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify({
      brandBrain: value.brandBrain,
      report: value.report,
      quality: value.quality,
    });
  } catch {
    return null;
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) return null;
  return {
    organizationId,
    userId,
    assistantId,
    brandId,
    snapshotId,
    brandBrain: value.brandBrain,
    report: value.report,
    quality: value.quality as Record<string, unknown> | null,
  };
}

export function createBrandIntelligenceArchiveService(
  db: Database,
  config: BrandIntelligenceArchiveConfig,
  dependencies: BrandIntelligenceArchiveDependencies = {},
) {
  ensureBrandIntelligenceArchiveSchema(db);
  const now = dependencies.now ?? (() => new Date());
  const fetchImpl = dependencies.fetch ?? fetch;
  const resolve = dependencies.resolveHostname ?? resolveHostname;
  const objectStore =
    dependencies.objectStore ??
    (config.enabled ? createS3ObjectStore(config) : undefined);

  const enqueue = (
    request: BrandIntelligenceArchiveRequest,
  ): BrandIntelligenceArchiveJobResult => {
    if (!config.enabled || !objectStore) {
      return {
        jobId: archiveJobId(request),
        snapshotId: request.snapshotId,
        status: "disabled",
        idempotent: true,
      };
    }
    const id = archiveJobId(request);
    const timestamp = now().toISOString();
    const existing = db
      .query<
        Pick<ArchiveJobRow, "status">,
        [string]
      >("SELECT status FROM brand_intelligence_archive_jobs WHERE id = ?")
      .get(id);
    if (existing?.status === "complete" || existing?.status === "partial") {
      return {
        jobId: id,
        snapshotId: request.snapshotId,
        status: existing.status,
        idempotent: true,
      };
    }
    const payload = JSON.stringify(request);
    if (Buffer.byteLength(payload, "utf8") > config.maxJobBytes) {
      throw new Error("archive_payload_too_large");
    }
    db.query(
      `INSERT INTO brand_intelligence_archive_jobs (
        id, organization_id, user_id, assistant_id, brand_id, snapshot_id,
        payload_json, status, attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload_json = excluded.payload_json,
        status = 'queued',
        next_attempt_at = excluded.next_attempt_at,
        error_code = NULL,
        error_message = NULL,
        updated_at = excluded.updated_at`,
    ).run(
      id,
      request.organizationId,
      request.userId,
      request.assistantId,
      request.brandId,
      request.snapshotId,
      payload,
      now().getTime(),
      timestamp,
      timestamp,
    );
    return {
      jobId: id,
      snapshotId: request.snapshotId,
      status: "queued",
      idempotent: Boolean(existing),
    };
  };

  const processNext = async (): Promise<boolean> => {
    if (!config.enabled || !objectStore) return false;
    const job = claimNextJob(db, now());
    if (!job) return false;
    try {
      const request = JSON.parse(
        job.payload_json,
      ) as BrandIntelligenceArchiveRequest;
      const result = await archiveRequest({
        db,
        config,
        objectStore,
        fetchImpl,
        resolve,
        request,
        now,
      });
      const completedAt = now().toISOString();
      db.query(
        `UPDATE brand_intelligence_archive_jobs
         SET status = ?, completed_at = ?, error_code = NULL,
             error_message = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(
        result.partial ? "partial" : "complete",
        completedAt,
        completedAt,
        job.id,
      );
    } catch (error) {
      const attempt = job.attempt_count + 1;
      const terminal =
        attempt >= MAX_ARCHIVE_ATTEMPTS || error instanceof ArchiveQuotaError;
      const delayMs = Math.min(
        60 * 60_000,
        30_000 * 2 ** Math.max(0, attempt - 1),
      );
      const timestamp = now().toISOString();
      db.query(
        `UPDATE brand_intelligence_archive_jobs
         SET status = 'failed', attempt_count = ?, next_attempt_at = ?,
             error_code = ?, error_message = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        terminal ? MAX_ARCHIVE_ATTEMPTS : attempt,
        terminal ? Number.MAX_SAFE_INTEGER : now().getTime() + delayMs,
        archiveErrorCode(error),
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Archive failed.",
        timestamp,
        job.id,
      );
    }
    return true;
  };

  const usage = (request: {
    organizationId: string;
    assistantId: string;
    brandId: string;
  }): BrandIntelligenceArchiveUsage => readArchiveUsage(db, config, request);

  return Object.freeze({
    enqueue,
    processNext,
    usage,
    enabled: config.enabled,
  });
}

export function startBrandIntelligenceArchiveWorker(
  service: ReturnType<typeof createBrandIntelligenceArchiveService>,
  intervalMs = 5_000,
): () => void {
  if (!service.enabled) return () => undefined;
  let active = false;
  const tick = async () => {
    if (active) return;
    active = true;
    try {
      for (let count = 0; count < 2; count += 1) {
        if (!(await service.processNext())) break;
      }
    } finally {
      active = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}

async function archiveRequest(input: {
  db: Database;
  config: BrandIntelligenceArchiveConfig;
  objectStore: BrandIntelligenceObjectStore;
  fetchImpl: ArchiveFetch;
  resolve: typeof resolveHostname;
  request: BrandIntelligenceArchiveRequest;
  now: () => Date;
}): Promise<{ partial: boolean }> {
  const visuals: ArchivedVisual[] = [];
  for (const candidate of visualCandidates(
    input.request.report,
    input.config.maxVisualAssets,
  )) {
    try {
      const asset = await fetchPublicImage(
        candidate.assetUrl,
        input.config,
        input.fetchImpl,
        input.resolve,
      );
      const checksum = sha256(asset.body);
      const extension = imageExtension(asset.contentType);
      const objectKey = archiveVisualObjectKey(
        input.request,
        checksum,
        extension,
      );
      await putObjectWithQuota({
        ...input,
        objectKey,
        kind: "visual",
        contentType: asset.contentType,
        checksum,
        body: asset.body,
        sourceUrl: candidate.assetUrl,
      });
      visuals.push({
        ...candidate,
        archived: true,
        objectKey,
        contentType: asset.contentType,
        sizeBytes: asset.body.byteLength,
        checksumSha256: checksum,
      });
    } catch (error) {
      visuals.push({
        ...candidate,
        archived: false,
        reason: archiveErrorCode(error),
      });
    }
  }

  const manifest = {
    version: ARCHIVE_FORMAT,
    archivedAt: input.now().toISOString(),
    organizationId: input.request.organizationId,
    assistantId: input.request.assistantId,
    brandId: input.request.brandId,
    snapshotId: input.request.snapshotId,
    brandBrain: input.request.brandBrain,
    report: input.request.report,
    quality: input.request.quality,
    visuals,
    preservation: {
      brandBrainPreserved: true,
      reportPreserved: true,
      visualAssetsRequested: visuals.length,
      visualAssetsPreserved: visuals.filter((visual) => visual.archived).length,
      fullVideosPreserved: false,
      videoPolicy:
        "Video metadata, source links, transcripts, and thumbnails are preserved; full video files are not copied in the pilot tier.",
    },
  };
  const body = Buffer.from(canonicalJson(manifest), "utf8");
  const checksum = sha256(body);
  await putObjectWithQuota({
    ...input,
    objectKey: archiveSnapshotObjectKey(input.request),
    kind: "snapshot",
    contentType: "application/json",
    checksum,
    body,
    sourceUrl: null,
  });
  return { partial: visuals.some((visual) => !visual.archived) };
}

async function putObjectWithQuota(input: {
  db: Database;
  config: BrandIntelligenceArchiveConfig;
  objectStore: BrandIntelligenceObjectStore;
  request: BrandIntelligenceArchiveRequest;
  now: () => Date;
  objectKey: string;
  kind: "snapshot" | "visual";
  contentType: string;
  checksum: string;
  body: Uint8Array;
  sourceUrl: string | null;
}): Promise<void> {
  const existing = input.db
    .query<StoredObjectRow, [string]>(
      `SELECT status, size_bytes, object_key
       FROM brand_intelligence_archive_objects WHERE object_key = ?`,
    )
    .get(input.objectKey);
  if (existing?.status === "stored") return;
  const sizeBytes = input.body.byteLength;
  const timestamp = input.now().toISOString();
  input.db
    .transaction(() => {
      const usage = readArchiveUsage(
        input.db,
        input.config,
        input.request,
        input.objectKey,
      );
      if (usage.globalBytes + sizeBytes > input.config.globalMaxBytes) {
        throw new ArchiveQuotaError("global_quota");
      }
      if (usage.brandBytes + sizeBytes > input.config.perBrandMaxBytes) {
        throw new ArchiveQuotaError("brand_quota");
      }
      const id = sha256(
        Buffer.from(
          [
            "brand-intelligence-object-v1",
            input.request.organizationId,
            input.request.assistantId,
            input.objectKey,
          ].join("\0"),
        ),
      );
      input.db
        .query(
          `INSERT INTO brand_intelligence_archive_objects (
        id, organization_id, assistant_id, brand_id, snapshot_id, object_key,
        kind, content_type, checksum_sha256, size_bytes, source_url, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(object_key) DO UPDATE SET
        checksum_sha256 = excluded.checksum_sha256,
        size_bytes = excluded.size_bytes,
        source_url = excluded.source_url,
        status = 'pending',
        error_code = NULL,
        updated_at = excluded.updated_at`,
        )
        .run(
          id,
          input.request.organizationId,
          input.request.assistantId,
          input.request.brandId,
          input.request.snapshotId,
          input.objectKey,
          input.kind,
          input.contentType,
          input.checksum,
          sizeBytes,
          input.sourceUrl,
          timestamp,
          timestamp,
        );
    })
    .immediate();

  try {
    await input.objectStore.put(input.objectKey, input.body);
    input.db
      .query(
        `UPDATE brand_intelligence_archive_objects
       SET status = 'stored', error_code = NULL, updated_at = ?
       WHERE object_key = ?`,
      )
      .run(input.now().toISOString(), input.objectKey);
  } catch (error) {
    input.db
      .query(
        `UPDATE brand_intelligence_archive_objects
       SET status = 'failed', error_code = 'storage_unavailable', updated_at = ?
       WHERE object_key = ?`,
      )
      .run(input.now().toISOString(), input.objectKey);
    throw error;
  }
}

function claimNextJob(db: Database, now: Date): ArchiveJobRow | null {
  return db
    .transaction(() => {
      const job = db
        .query<ArchiveJobRow, [number, number]>(
          `SELECT * FROM brand_intelligence_archive_jobs
         WHERE status IN ('queued', 'failed')
           AND next_attempt_at <= ?
           AND attempt_count < ?
         ORDER BY created_at ASC
         LIMIT 1`,
        )
        .get(now.getTime(), MAX_ARCHIVE_ATTEMPTS);
      if (!job) return null;
      const claimed = db
        .query(
          `UPDATE brand_intelligence_archive_jobs
       SET status = 'running', updated_at = ?
       WHERE id = ? AND status IN ('queued', 'failed')`,
        )
        .run(now.toISOString(), job.id);
      return claimed.changes === 1 ? job : null;
    })
    .immediate();
}

function readArchiveUsage(
  db: Database,
  config: BrandIntelligenceArchiveConfig,
  tenant: { organizationId: string; assistantId: string; brandId: string },
  excludedObjectKey = "",
): BrandIntelligenceArchiveUsage {
  const globalBytes = Number(
    db
      .query<{ total: number }, [string]>(
        `SELECT COALESCE(SUM(size_bytes), 0) AS total
         FROM brand_intelligence_archive_objects
         WHERE status IN ('pending', 'stored') AND object_key <> ?`,
      )
      .get(excludedObjectKey)?.total ?? 0,
  );
  const brandBytes = Number(
    db
      .query<{ total: number }, [string, string, string, string]>(
        `SELECT COALESCE(SUM(size_bytes), 0) AS total
         FROM brand_intelligence_archive_objects
         WHERE organization_id = ? AND assistant_id = ? AND brand_id = ?
           AND status IN ('pending', 'stored') AND object_key <> ?`,
      )
      .get(
        tenant.organizationId,
        tenant.assistantId,
        tenant.brandId,
        excludedObjectKey,
      )?.total ?? 0,
  );
  return {
    globalBytes,
    brandBytes,
    globalMaxBytes: config.globalMaxBytes,
    brandMaxBytes: config.perBrandMaxBytes,
    warning:
      globalBytes / config.globalMaxBytes >= config.warningPercent / 100 ||
      brandBytes / config.perBrandMaxBytes >= config.warningPercent / 100,
  };
}

function createS3ObjectStore(
  config: BrandIntelligenceArchiveConfig,
): BrandIntelligenceObjectStore {
  const endpoint = new URL(config.endpoint!);
  const client = new S3Client({
    bucket: config.bucket!,
    accessKeyId: config.accessKeyId!,
    secretAccessKey: config.secretAccessKey!,
    region: config.region!,
    endpoint:
      config.urlStyle === "path"
        ? endpoint.origin
        : endpoint.hostname === config.bucket ||
            endpoint.hostname.startsWith(`${config.bucket}.`)
          ? endpoint.origin
          : `https://${config.bucket}.${endpoint.hostname}`,
    virtualHostedStyle: config.urlStyle === "virtual",
  });
  return {
    put: async (objectKey, body) => {
      await client.write(objectKey, body);
    },
  };
}

function visualCandidates(
  report: Record<string, unknown>,
  limit: number,
): VisualCandidate[] {
  if (!Array.isArray(report.visualEvidence) || limit === 0) return [];
  const candidates: VisualCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of report.visualEvidence) {
    if (!isRecord(raw)) continue;
    const mediaType = boundedString(raw.mediaType, 128)?.toLowerCase() ?? "";
    const preferred = mediaType.startsWith("video/")
      ? boundedString(raw.thumbnailUrl, 4096)
      : (boundedString(raw.mediaUrl, 4096) ??
        boundedString(raw.thumbnailUrl, 4096));
    const sourceUrl = boundedString(raw.sourceUrl, 4096);
    if (!preferred || !sourceUrl || seen.has(preferred)) continue;
    seen.add(preferred);
    candidates.push({
      id: boundedString(raw.id, 256) ?? `visual-${candidates.length + 1}`,
      title: boundedString(raw.title, 512) ?? "Research visual",
      kind: boundedString(raw.kind, 128) ?? "other",
      module: boundedString(raw.module, 128),
      sourceUrl,
      assetUrl: preferred,
      observedAt: boundedString(raw.observedAt, 128),
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

async function fetchPublicImage(
  rawUrl: string,
  config: BrandIntelligenceArchiveConfig,
  fetchImpl: ArchiveFetch,
  resolve: typeof resolveHostname,
): Promise<{ body: Uint8Array; contentType: string }> {
  let url = new URL(rawUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    await assertPublicUrl(url, resolve);
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "image/*" },
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === 3)
        throw new Error("asset_redirect_invalid");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) throw new Error("asset_unavailable");
    const contentType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    if (!contentType.startsWith("image/")) throw new Error("asset_not_image");
    const announcedSize = Number(response.headers.get("content-length") ?? 0);
    if (announcedSize > config.maxAssetBytes)
      throw new Error("asset_too_large");
    return {
      body: await readBoundedBody(response.body, config.maxAssetBytes),
      contentType,
    };
  }
  throw new Error("asset_redirect_invalid");
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("asset_too_large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function assertPublicUrl(
  url: URL,
  resolve: typeof resolveHostname,
): Promise<void> {
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.hostname.toLowerCase() === "localhost" ||
    url.hostname.toLowerCase().endsWith(".localhost") ||
    url.hostname.toLowerCase().endsWith(".local") ||
    url.hostname.toLowerCase().endsWith(".internal")
  ) {
    throw new Error("asset_url_not_public");
  }
  const addresses = isIP(url.hostname)
    ? [url.hostname]
    : await resolve(url.hostname);
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isPublicIp(address))
  ) {
    throw new Error("asset_url_not_public");
  }
}

async function resolveHostname(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(
    ({ address }) => address,
  );
}

function isPublicIp(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51) ||
      (a === 203 && b === 0) ||
      a! >= 224
    );
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(value)?.[1];
    if (mappedIpv4) return isPublicIp(mappedIpv4);
    return !(
      value === "::" ||
      value === "::1" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      /^fe[89ab]/u.test(value) ||
      value.startsWith("2001:db8:")
    );
  }
  return false;
}

function archiveJobId(request: BrandIntelligenceArchiveRequest): string {
  return `brand_archive_${sha256(
    Buffer.from(
      [
        request.organizationId,
        request.assistantId,
        request.brandId,
        request.snapshotId,
      ].join("\0"),
    ),
  )}`;
}

function archiveSnapshotObjectKey(
  request: BrandIntelligenceArchiveRequest,
): string {
  return [
    "brand-intelligence",
    encodeURIComponent(request.organizationId),
    encodeURIComponent(request.assistantId),
    encodeURIComponent(request.brandId),
    "snapshots",
    `${request.snapshotId}.json`,
  ].join("/");
}

function archiveVisualObjectKey(
  request: BrandIntelligenceArchiveRequest,
  checksum: string,
  extension: string,
): string {
  return [
    "brand-intelligence",
    encodeURIComponent(request.organizationId),
    encodeURIComponent(request.assistantId),
    encodeURIComponent(request.brandId),
    "visuals",
    `${checksum}.${extension}`,
  ].join("/");
}

function imageExtension(contentType: string): string {
  const known: Record<string, string> = {
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/webp": "webp",
  };
  return known[contentType] ?? "img";
}

function archiveErrorCode(error: unknown): string {
  if (error instanceof ArchiveQuotaError) return error.code;
  if (error instanceof Error && /^[a-z0-9_]{3,64}$/u.test(error.message)) {
    return error.message;
  }
  return "archive_failed";
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function parseStorageEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("The brand intelligence archive endpoint is invalid.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.port ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
      endpoint.hostname,
    )
  ) {
    throw new Error("The brand intelligence archive endpoint is invalid.");
  }
  endpoint.pathname = "/";
  return endpoint;
}

function positiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function boundedInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= maxLength
    ? value.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
