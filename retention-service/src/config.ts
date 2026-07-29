import { z } from "zod";

const booleanFromEnv = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const positiveIntegerFromEnv = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const configSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    WORKLIN_RETENTION_MIGRATION_DATABASE_URL: z.string().url().optional(),
    WORKLIN_RETENTION_PORT: positiveIntegerFromEnv(8080),
    WORKLIN_RETENTION_HOST: z.string().default("::"),
    WORKLIN_RETENTION_SERVICE_JWT_SECRET: z.string().min(32),
    WORKLIN_RETENTION_SERVICE_WEBHOOK_SECRET: z.string().min(32),
    WORKLIN_RETENTION_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i),
    WORKLIN_RETENTION_TOKEN_ISSUER: z
      .string()
      .default("worklin-control-plane"),
    WORKLIN_RETENTION_TOKEN_AUDIENCE: z
      .string()
      .default("worklin-retention-service"),
    WORKLIN_RETENTION_EXTERNAL_WRITES_ENABLED: booleanFromEnv,
    WORKLIN_RETENTION_SEND_ENABLED: booleanFromEnv,
    WORKLIN_RETENTION_RUN_MIGRATIONS: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    WORKLIN_RETENTION_MAX_BODY_BYTES: positiveIntegerFromEnv(2 * 1024 * 1024),
    WORKLIN_RETENTION_DATABASE_TIMEOUT_MS: positiveIntegerFromEnv(10_000),
    WORKLIN_RETENTION_JOB_LEASE_SECONDS: positiveIntegerFromEnv(120),
    WORKLIN_RETENTION_MAX_JOB_ATTEMPTS: positiveIntegerFromEnv(8),
    WORKLIN_RETENTION_BUCKET_ENDPOINT: z.string().url().optional(),
    WORKLIN_RETENTION_BUCKET_NAME: z.string().min(1).optional(),
    WORKLIN_RETENTION_BUCKET_REGION: z.string().min(1).optional(),
    WORKLIN_RETENTION_BUCKET_ACCESS_KEY_ID: z.string().min(1).optional(),
    WORKLIN_RETENTION_BUCKET_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    WORKLIN_RETENTION_BUCKET_VIRTUAL_HOSTED_STYLE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .superRefine((value, context) => {
    if (
      value.WORKLIN_RETENTION_RUN_MIGRATIONS &&
      !value.WORKLIN_RETENTION_MIGRATION_DATABASE_URL
    ) {
      context.addIssue({
        code: "custom",
        path: ["WORKLIN_RETENTION_MIGRATION_DATABASE_URL"],
        message:
          "A separate migration database URL is required when startup migrations are enabled.",
      });
    }
    const bucketFields = [
      value.WORKLIN_RETENTION_BUCKET_ENDPOINT,
      value.WORKLIN_RETENTION_BUCKET_NAME,
      value.WORKLIN_RETENTION_BUCKET_ACCESS_KEY_ID,
      value.WORKLIN_RETENTION_BUCKET_SECRET_ACCESS_KEY,
    ];
    if (bucketFields.some(Boolean) && !bucketFields.every(Boolean)) {
      context.addIssue({
        code: "custom",
        path: ["WORKLIN_RETENTION_BUCKET_ENDPOINT"],
        message:
          "The retention bucket endpoint, name, access key, and secret key must be configured together.",
      });
    }
    if (!bucketFields.every(Boolean)) {
      context.addIssue({
        code: "custom",
        path: ["WORKLIN_RETENTION_BUCKET_ENDPOINT"],
        message:
          "A private encrypted-payload bucket is required for the retention service.",
      });
    }
  });

export type RetentionServiceConfig = {
  databaseUrl: string;
  migrationDatabaseUrl: string | null;
  port: number;
  host: string;
  signingKey: Buffer;
  providerWebhookKey: Buffer;
  encryptionKey: Buffer;
  tokenIssuer: string;
  tokenAudience: string;
  externalWritesEnabled: boolean;
  sendEnabled: boolean;
  runMigrations: boolean;
  maxBodyBytes: number;
  databaseTimeoutMs: number;
  jobLeaseSeconds: number;
  maxJobAttempts: number;
  bucket: {
    endpoint: string;
    name: string;
    region?: string;
    accessKeyId: string;
    secretAccessKey: string;
    virtualHostedStyle: boolean;
  };
};

export function retentionServiceConfigFromEnv(
  env: NodeJS.ProcessEnv,
): RetentionServiceConfig {
  const parsed = configSchema.parse(env);
  const bucket = {
    endpoint: parsed.WORKLIN_RETENTION_BUCKET_ENDPOINT!,
    name: parsed.WORKLIN_RETENTION_BUCKET_NAME!,
    accessKeyId: parsed.WORKLIN_RETENTION_BUCKET_ACCESS_KEY_ID!,
    secretAccessKey:
      parsed.WORKLIN_RETENTION_BUCKET_SECRET_ACCESS_KEY!,
    virtualHostedStyle:
      parsed.WORKLIN_RETENTION_BUCKET_VIRTUAL_HOSTED_STYLE,
    ...(parsed.WORKLIN_RETENTION_BUCKET_REGION
      ? { region: parsed.WORKLIN_RETENTION_BUCKET_REGION }
      : {}),
  };

  return {
    databaseUrl: parsed.DATABASE_URL,
    migrationDatabaseUrl:
      parsed.WORKLIN_RETENTION_MIGRATION_DATABASE_URL ?? null,
    port: parsed.WORKLIN_RETENTION_PORT,
    host: parsed.WORKLIN_RETENTION_HOST,
    signingKey: Buffer.from(
      parsed.WORKLIN_RETENTION_SERVICE_JWT_SECRET,
      "utf8",
    ),
    providerWebhookKey: Buffer.from(
      parsed.WORKLIN_RETENTION_SERVICE_WEBHOOK_SECRET,
      "utf8",
    ),
    encryptionKey: Buffer.from(
      parsed.WORKLIN_RETENTION_ENCRYPTION_KEY,
      "hex",
    ),
    tokenIssuer: parsed.WORKLIN_RETENTION_TOKEN_ISSUER,
    tokenAudience: parsed.WORKLIN_RETENTION_TOKEN_AUDIENCE,
    externalWritesEnabled:
      parsed.WORKLIN_RETENTION_EXTERNAL_WRITES_ENABLED,
    sendEnabled: parsed.WORKLIN_RETENTION_SEND_ENABLED,
    runMigrations: parsed.WORKLIN_RETENTION_RUN_MIGRATIONS,
    maxBodyBytes: parsed.WORKLIN_RETENTION_MAX_BODY_BYTES,
    databaseTimeoutMs: parsed.WORKLIN_RETENTION_DATABASE_TIMEOUT_MS,
    jobLeaseSeconds: parsed.WORKLIN_RETENTION_JOB_LEASE_SECONDS,
    maxJobAttempts: parsed.WORKLIN_RETENTION_MAX_JOB_ATTEMPTS,
    bucket,
  };
}
