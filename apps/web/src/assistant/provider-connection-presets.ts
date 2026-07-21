import type {
  ConnectionProvider,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

export interface ProviderConnectionPreset {
  readonly id: string;
  readonly provider: ConnectionProvider;
  readonly displayName: string;
  readonly connectionName: string;
  readonly credentialName: string;
  readonly baseUrl?: string;
  readonly models?: readonly { id: string; displayName?: string }[];
  readonly defaultModel?: string;
}

export const XAI_PROVIDER_PRESET = {
  id: "xai",
  provider: "openai-compatible",
  displayName: "xAI",
  connectionName: "xai-personal",
  credentialName: "xai",
  baseUrl: "https://api.x.ai/v1",
  models: [{ id: "grok-4.3", displayName: "Grok 4.3" }],
  defaultModel: "grok-4.3",
} as const satisfies ProviderConnectionPreset;

export function connectionMatchesPreset(
  connection: ProviderConnection,
  preset: ProviderConnectionPreset,
): boolean {
  if (connection.provider !== preset.provider) return false;
  if (!preset.baseUrl) return true;

  const normalizedConnectionUrl = connection.baseUrl?.replace(/\/+$/, "");
  const normalizedPresetUrl = preset.baseUrl.replace(/\/+$/, "");
  return normalizedConnectionUrl === normalizedPresetUrl;
}
