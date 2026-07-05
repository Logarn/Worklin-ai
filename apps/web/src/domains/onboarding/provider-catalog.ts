// Trimmed model-provider catalog for the onboarding "Connect a Model Provider"
// step. Ported from the daemon/macOS catalog
// (clients/shared/Resources/llm-provider-catalog.json), limited to the
// providers the web daemon client supports (see ConnectionProvider in
// domains/settings) and to the fields the onboarding UI needs.

export type OnboardingProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "ollama"
  | "fireworks"
  | "kimi"
  | "openrouter"
  | "minimax"
  | "openai-compatible";

export type OnboardingProviderOptionId =
  OnboardingProviderId | "chatgpt-subscription" | "xai";

export type OnboardingProviderAuthType =
  "api_key" | "none" | "oauth_subscription";

export interface OnboardingProvider {
  readonly id: OnboardingProviderOptionId;
  readonly provider: OnboardingProviderId;
  readonly authType: OnboardingProviderAuthType;
  readonly displayName: string;
  readonly subtitle: string;
  readonly badge?: string;
  /** Placeholder for the API-key input; null for keyless providers. */
  readonly apiKeyPlaceholder: string | null;
  /** "Get an API key here" docs URL; null when the provider has none. */
  readonly docsUrl: string | null;
  /** Whether an API key is required before the user can continue. */
  readonly requiresKey: boolean;
  /** Stable connection name to create during hatch. Defaults to provider-personal. */
  readonly connectionName?: string;
  /** Credential namespace for API-key storage. Defaults to provider. */
  readonly credentialName?: string;
  /** Optional label for the created connection. */
  readonly connectionLabel?: string;
  /** OpenAI-compatible base URL preset. */
  readonly baseUrl?: string;
  /** OpenAI-compatible model identifiers exposed by this endpoint. */
  readonly models?: readonly { id: string; displayName?: string }[];
  /** Default model for the onboarding profile. */
  readonly defaultModel?: string;
}

export const ONBOARDING_PROVIDERS: readonly OnboardingProvider[] = [
  {
    id: "chatgpt-subscription",
    provider: "openai",
    authType: "oauth_subscription",
    displayName: "ChatGPT Subscription",
    subtitle: "Sign in with ChatGPT. No API key needed.",
    badge: "Recommended",
    apiKeyPlaceholder: null,
    docsUrl: null,
    requiresKey: false,
  },
  {
    id: "anthropic",
    provider: "anthropic",
    authType: "api_key",
    displayName: "Anthropic",
    subtitle: "Use Claude with an Anthropic API key.",
    apiKeyPlaceholder: "sk-ant-api03-...",
    docsUrl: "https://console.anthropic.com/settings/keys",
    requiresKey: true,
  },
  {
    id: "openai",
    provider: "openai",
    authType: "api_key",
    displayName: "OpenAI API",
    subtitle: "Use OpenAI platform billing with an API key.",
    apiKeyPlaceholder: "sk-proj-...",
    docsUrl: "https://platform.openai.com/api-keys",
    requiresKey: true,
  },
  {
    id: "xai",
    provider: "openai-compatible",
    authType: "api_key",
    displayName: "xAI",
    subtitle: "Use Grok with an xAI API key.",
    apiKeyPlaceholder: "xai-...",
    docsUrl: "https://console.x.ai/",
    requiresKey: true,
    connectionName: "xai-personal",
    credentialName: "xai",
    connectionLabel: "xAI",
    baseUrl: "https://api.x.ai/v1",
    models: [{ id: "grok-4.3", displayName: "Grok 4.3" }],
    defaultModel: "grok-4.3",
  },
  {
    id: "kimi",
    provider: "kimi",
    authType: "api_key",
    displayName: "Kimi",
    subtitle: "Use Kimi models with a Moonshot API key.",
    apiKeyPlaceholder: "sk-...",
    docsUrl: "https://platform.kimi.ai/console/api-keys",
    requiresKey: true,
    defaultModel: "kimi-k2.6",
  },
  {
    id: "gemini",
    provider: "gemini",
    authType: "api_key",
    displayName: "Google Gemini",
    subtitle: "Use Gemini with a Google AI Studio key.",
    apiKeyPlaceholder: "AIza...",
    docsUrl: "https://aistudio.google.com/apikey",
    requiresKey: true,
  },
  {
    id: "openrouter",
    provider: "openrouter",
    authType: "api_key",
    displayName: "OpenRouter",
    subtitle: "Use one key for many models, including Mistral and xAI/Grok.",
    apiKeyPlaceholder: "sk-or-v1-...",
    docsUrl: "https://openrouter.ai/keys",
    requiresKey: true,
  },
  {
    id: "minimax",
    provider: "minimax",
    authType: "api_key",
    displayName: "MiniMax",
    subtitle: "Use MiniMax models with a MiniMax API key.",
    apiKeyPlaceholder: "sk-cp-...",
    docsUrl: "https://platform.minimax.io/",
    requiresKey: true,
  },
  {
    id: "fireworks",
    provider: "fireworks",
    authType: "api_key",
    displayName: "Fireworks",
    subtitle: "Use open-source models with a Fireworks API key.",
    apiKeyPlaceholder: "fw_...",
    docsUrl: "https://fireworks.ai/account/api-keys",
    requiresKey: true,
  },
  {
    id: "ollama",
    provider: "ollama",
    authType: "none",
    displayName: "Ollama",
    subtitle: "Use local models already running on this machine.",
    apiKeyPlaceholder: null,
    docsUrl: "https://ollama.com/download",
    requiresKey: false,
    defaultModel: "llama3.2",
  },
];

export const DEFAULT_ONBOARDING_PROVIDER = ONBOARDING_PROVIDERS[0];

export function onboardingProvider(id: string): OnboardingProvider | undefined {
  return ONBOARDING_PROVIDERS.find((p) => p.id === id);
}
