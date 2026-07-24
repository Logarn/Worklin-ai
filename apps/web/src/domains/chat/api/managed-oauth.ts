import type { OAuthConnection } from "@/generated/api/types.gen";
import { oauthProvidersGet } from "@/generated/daemon/sdk.gen";
import type { OauthProvidersGetResponses } from "@/generated/daemon/types.gen";
import {
  connectManagedOAuth,
  type ManagedOAuthConnectResult as SharedManagedOAuthConnectResult,
} from "@/lib/auth/managed-oauth-flow";

export type ManagedOAuthProviderSummary =
  OauthProvidersGetResponses[200]["providers"][number];

export interface ManagedOAuthConnectOptions {
  assistantId: string;
  providerKey: string;
  providerLabel: string;
  signal?: AbortSignal;
}

export type ManagedOAuthConnectResult =
  | { status: "connected"; connection: OAuthConnection }
  | { status: "cancelled"; message?: string }
  | { status: "error"; message: string };

export interface ManagedOAuthConnectClient {
  fetchProvider: (
    assistantId: string,
    providerKey: string,
  ) => Promise<ManagedOAuthProviderSummary | null>;
  connect: (
    options: ManagedOAuthConnectOptions,
  ) => Promise<ManagedOAuthConnectResult>;
}

export async function fetchManagedOAuthProvider(
  assistantId: string,
  providerKey: string,
): Promise<ManagedOAuthProviderSummary | null> {
  const { data, error } = await oauthProvidersGet({
    path: { assistant_id: assistantId },
    query: { supports_managed_mode: "true" },
    throwOnError: false,
  });
  if (error || !data) return null;

  return (
    data.providers.find(
      (provider) =>
        provider.provider_key === providerKey && provider.supports_managed_mode,
    ) ?? null
  );
}

export async function connectManagedOAuthProvider(
  options: ManagedOAuthConnectOptions,
): Promise<ManagedOAuthConnectResult> {
  const result: SharedManagedOAuthConnectResult =
    await connectManagedOAuth(options);
  if (result.status !== "error") return result;
  return { status: "error", message: result.message };
}

export const defaultManagedOAuthConnectClient: ManagedOAuthConnectClient = {
  fetchProvider: fetchManagedOAuthProvider,
  connect: connectManagedOAuthProvider,
};
