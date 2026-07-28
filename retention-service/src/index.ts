import { RetentionCrypto } from "./crypto.js";
import {
  retentionServiceConfigFromEnv,
} from "./config.js";
import { RetentionDatabase } from "./database.js";
import { createRetentionHttpHandler } from "./http.js";
import { RetentionRepository } from "./repository.js";
import { S3RawPayloadStore } from "./raw-payload-store.js";
import { RetentionServiceWorker } from "./worker.js";

const config = retentionServiceConfigFromEnv(process.env);

if (config.runMigrations) {
  const migrationDatabase = new RetentionDatabase(
    config.migrationDatabaseUrl!,
    { timeoutMs: config.databaseTimeoutMs },
  );
  try {
    await migrationDatabase.migrate();
  } finally {
    await migrationDatabase.close();
  }
  console.log("retention_service_migrations_applied");
  process.exit(0);
}

const database = new RetentionDatabase(config.databaseUrl, {
  timeoutMs: config.databaseTimeoutMs,
});
const crypto = new RetentionCrypto(config.encryptionKey);
const rawPayloadStore = new S3RawPayloadStore({
  endpoint: config.bucket.endpoint,
  bucket: config.bucket.name,
  accessKeyId: config.bucket.accessKeyId,
  secretAccessKey: config.bucket.secretAccessKey,
  ...(config.bucket.region ? { region: config.bucket.region } : {}),
  virtualHostedStyle: config.bucket.virtualHostedStyle,
});
const [
  databaseReady,
  migrationsReady,
  tenantIsolationReady,
  rawPayloadStoreReady,
] = await Promise.all([
  database.ready(),
  database.migrationsReady(),
  database.tenantIsolationReady(),
  rawPayloadStore.ready(),
]);
if (
  !databaseReady ||
  !migrationsReady ||
  !tenantIsolationReady ||
  !rawPayloadStoreReady
) {
  await database.close();
  throw new Error("Retention service startup prerequisites are unsafe.");
}
const repository = new RetentionRepository(database, crypto, {
  maxJobAttempts: config.maxJobAttempts,
  jobLeaseSeconds: config.jobLeaseSeconds,
  externalWritesEnabled: config.externalWritesEnabled,
  sendEnabled: config.sendEnabled,
  rawPayloadStore,
});
const worker = new RetentionServiceWorker(repository);
const handler = createRetentionHttpHandler({
  config,
  database,
  rawPayloadStore,
  repository,
  worker,
});

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: handler,
});
worker.start();

console.log("retention_service_started", {
  hostname: server.hostname,
  port: server.port,
  externalWritesEnabled: config.externalWritesEnabled,
  sendEnabled: config.sendEnabled,
});

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log("retention_service_stopping", { signal });
  server.stop(false);
  await worker.stop();
  await database.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  void stop("SIGINT");
});
process.on("SIGTERM", () => {
  void stop("SIGTERM");
});
