import type {
  ProviderConnection,
  SecretsGetResponse,
} from "@/generated/daemon/types.gen";

type SecretMetadata = SecretsGetResponse["secrets"][number];

export function isPersonalProviderConnection(
  connection: ProviderConnection,
): boolean {
  return connection.auth.type !== "platform" && !connection.isManaged;
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
    return secret.type === "api_key" && secret.name === service;
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
