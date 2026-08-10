import {
  initAuthSigningKey,
  resolveSigningKey,
} from "../runtime/auth/token-service.js";
import { getLogger } from "../util/logger.js";
import { createConcurrentRuntimeHttpHandler } from "./http-server.js";
import { PostgresConcurrentRuntimeStore } from "./postgres-store.js";
import { ConcurrentRuntimeService } from "./service.js";
import { ConfiguredProviderTurnExecutor } from "./turn-executor.js";

const log = getLogger("concurrent-runtime-main");

function positiveInteger(name: string, fallback: number, minimum = 1): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(
      `${name} must be an integer greater than or equal to ${minimum}.`,
    );
  }
  return parsed;
}

const databaseUrl = process.env.CONCURRENT_RUNTIME_DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("CONCURRENT_RUNTIME_DATABASE_URL is required.");
}
if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  throw new Error(
    "ANTHROPIC_API_KEY is required for concurrent managed inference.",
  );
}

initAuthSigningKey(resolveSigningKey());

const store = new PostgresConcurrentRuntimeStore({
  applicationDatabaseUrl: databaseUrl,
  migrationDatabaseUrl:
    process.env.CONCURRENT_RUNTIME_MIGRATION_DATABASE_URL?.trim(),
  maxConnections: positiveInteger(
    "CONCURRENT_RUNTIME_DATABASE_MAX_CONNECTIONS",
    20,
  ),
});
const service = new ConcurrentRuntimeService({
  store,
  executor: new ConfiguredProviderTurnExecutor({
    systemPrompt:
      "You are Worklin, a helpful assistant. Respond directly and do not claim to use tools that are unavailable.",
  }),
  maxConcurrentTurns: positiveInteger(
    "CONCURRENT_RUNTIME_MAX_CONCURRENT_TURNS",
    32,
  ),
  maxConcurrentTurnsPerTenant: positiveInteger(
    "CONCURRENT_RUNTIME_MAX_CONCURRENT_TURNS_PER_TENANT",
    2,
  ),
  leaseDurationMs: positiveInteger(
    "CONCURRENT_RUNTIME_LEASE_DURATION_MS",
    10 * 60_000,
    1_000,
  ),
  logger: log,
});
await service.initialize();

const handler = createConcurrentRuntimeHttpHandler({
  store,
  service,
  logger: log,
  eventPollIntervalMs: positiveInteger(
    "CONCURRENT_RUNTIME_EVENT_POLL_INTERVAL_MS",
    250,
    25,
  ),
});
const port = positiveInteger(
  "CONCURRENT_RUNTIME_PORT",
  positiveInteger("RUNTIME_HTTP_PORT", 3001),
);
const hostname =
  process.env.CONCURRENT_RUNTIME_HOST?.trim() ||
  process.env.RUNTIME_HTTP_HOST?.trim() ||
  "0.0.0.0";

const server = Bun.serve({
  hostname,
  port,
  fetch: handler,
});

log.info(
  {
    hostname: server.hostname,
    port: server.port,
    mode: "concurrent_service",
  },
  "Concurrent assistant service listening",
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "Concurrent assistant service shutting down");
  server.stop(false);
  await service.onIdle();
  await store.close();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
