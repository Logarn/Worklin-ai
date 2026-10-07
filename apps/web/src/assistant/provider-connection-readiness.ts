import type {
  ProviderConnection,
  SecretsGetResponse,
} from "@/generated/daemon/types.gen";

type SecretMetadata = SecretsGetResponse["secrets"][number];

export const CHATGPT_SUBSCRIPTION_FALLBACK_MODELS = [
  { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" },
  { id: "gpt-6-sol", displayName: "GPT-6 Sol" },
  { id: "gpt-6-luna", displayName: "GPT-6 Luna" },
] as const;

export function chatgptSubscriptionModels(
  connection: Pick<ProviderConnection, "models">,
): readonly { id: string; displayName?: string }[] {
  return connection.models ?? CHATGPT_SUBSCRIPTION_FALLBACK_MODELS;
}

export function chatgptSubscriptionDefaultModel(
  connection?: Pick<ProviderConnection, "models">,
): string {
  return (
    (connection ? chatgptSubscriptionModels(connection) : undefined)?.[0]?.id ??
    CHATGPT_SUBSCRIPTION_FALLBACK_MODELS[0].id
  );
}

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
  connection: Pick<ProviderConnection, "auth"> &
    Partial<Pick<ProviderConnection, "models">>,
  model: string | undefined,
): boolean {
  if (connection.auth.type !== "oauth_subscription" || !model) return true;
  const models =
    connection.models === undefined
      ? CHATGPT_SUBSCRIPTION_FALLBACK_MODELS
      : chatgptSubscriptionModels({ models: connection.models });
  return models.some((candidate) => candidate.id === model);
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
      (secret.type === "credential" && secret.name === `${service}:api_key`)
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
