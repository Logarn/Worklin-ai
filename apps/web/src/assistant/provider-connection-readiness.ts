import type {
  ProviderConnection,
  SecretsGetResponse,
} from "@/generated/daemon/types.gen";

type SecretMetadata = SecretsGetResponse["secrets"][number];

const CHATGPT_SUBSCRIPTION_MODEL_IDS: ReadonlySet<string> = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
]);

export function isPersonalProviderConnection(
  connection: ProviderConnection,
): boolean {
  return connection.auth.type !== "platform" && !connection.isManaged;
}

export function canSafelyUseAnyProviderConnection(
  connections: readonly ProviderConnection[],
): boolean {
  return (
    connections.length > 1 && connections.every(isPersonalProviderConnection)
  );
}

export function isProviderConnectionCompatibleWithModel(
  connection: Pick<ProviderConnection, "auth">,
  model: string | undefined,
): boolean {
  if (connection.auth.type !== "oauth_subscription" || !model) return true;
  return CHATGPT_SUBSCRIPTION_MODEL_IDS.has(model);
}

function credentialMetadataMatches(
  credentialRef: string,
  secret: SecretMetadata,
): boolean {
  const prefix = "credential/";
  if (!credentialRef.startsWith(prefix)) return false;

  const rest = credentialRef.slice(prefix.length);
  const slashIndex = rest.indexOf("/");
  if (slashIndex < 1 || slashIndex >= rest.length - 1) return false;

  const service = rest.slice(0, slashIndex);
  const field = rest.slice(slashIndex + 1);
  if (field === "api_key") {
    return (
      (secret.type === "api_key" && secret.name === service) ||
      (secret.type === "credential" &&
        secret.name === `${service}:api_key`)
    );
  }

  return secret.type === "credential" && secret.name === `${service}:${field}`;
}

export function isProviderConnectionReady(
  connection: ProviderConnection,
  secrets: readonly SecretMetadata[],
): boolean {
  if (!isPersonalProviderConnection(connection)) return false;
  if (connection.auth.type === "none") return true;
  if (connection.auth.type === "platform") return false;
  const credentialRef = connection.auth.credential;

  return secrets.some((secret) =>
    credentialMetadataMatches(credentialRef, secret),
  );
}
