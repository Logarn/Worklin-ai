import type { DrizzleDb } from "../../memory/db-connection.js";
import { getLogger } from "../../util/logger.js";
import type { ProviderConnection } from "../inference/auth.js";
import { getValidCodexAccessToken } from "../inference/codex-token-refresh.js";
import { getConnection, updateConnection } from "../inference/connections.js";
import { fetchCodexSubscriptionModels } from "./codex-models.js";

const log = getLogger("codex-model-refresh");

const CATALOG_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const EMPTY_CATALOG_RETRY_INTERVAL_MS = 5 * 60 * 1000;

const refreshesInFlight = new Map<string, Promise<ProviderConnection>>();

function isChatgptSubscriptionConnection(
  connection: ProviderConnection,
): boolean {
  return (
    connection.provider === "openai" &&
    connection.auth.type === "oauth_subscription"
  );
}

function shouldRefresh(
  connection: ProviderConnection,
  force: boolean,
): boolean {
  if (force) return true;
  const age = Date.now() - connection.updatedAt;
  return connection.models === null
    ? age >= EMPTY_CATALOG_RETRY_INTERVAL_MS
    : age >= CATALOG_REFRESH_INTERVAL_MS;
}

async function refreshConnection(
  db: DrizzleDb,
  connection: ProviderConnection,
): Promise<ProviderConnection> {
  if (connection.auth.type !== "oauth_subscription") return connection;

  const credentialPrefix = connection.auth.credential.replace(
    /\/access_token$/,
    "",
  );
  const accessToken = await getValidCodexAccessToken(credentialPrefix);
  if (!accessToken) return connection;

  try {
    const models = await fetchCodexSubscriptionModels(accessToken);
    const latest = getConnection(db, connection.name);
    if (!latest || latest.auth.type !== "oauth_subscription") {
      return latest ?? connection;
    }

    const result = updateConnection(db, latest.name, {
      auth: latest.auth,
      models,
    });
    return result.ok ? result.connection : latest;
  } catch (error) {
    log.warn(
      { err: error, connectionName: connection.name },
      "ChatGPT subscription model catalog refresh failed",
    );
    return connection;
  }
}

export async function refreshCodexSubscriptionConnectionModels(
  db: DrizzleDb,
  connection: ProviderConnection,
  options: { force?: boolean } = {},
): Promise<ProviderConnection> {
  if (
    !isChatgptSubscriptionConnection(connection) ||
    !shouldRefresh(connection, options.force === true)
  ) {
    return connection;
  }

  const current = refreshesInFlight.get(connection.name);
  if (current) return await current;

  const refresh = refreshConnection(db, connection);
  refreshesInFlight.set(connection.name, refresh);
  try {
    return await refresh;
  } finally {
    refreshesInFlight.delete(connection.name);
  }
}
