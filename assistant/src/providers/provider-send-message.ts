/**
 * Helper utilities for provider callsites that should stay decoupled from
 * provider SDK details. Includes provider resolution, timeout utilities,
 * and response extraction helpers.
 */

import { isConcurrentServiceRuntime } from "../config/env.js";
import {
  resolveCallSiteConfig,
  type ResolveCallSiteOpts,
} from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { getDb } from "../memory/db-connection.js";
import { getLogger } from "../util/logger.js";
import {
  describeSubscriptionModelIncompatibility,
  isConnectionCompatibleWithModel,
} from "./connection-model-compat.js";
import {
  isPersonalProviderConnection,
  tryResolveProviderForConnectionName,
} from "./connection-resolution.js";
import type { ProviderConnection } from "./inference/auth.js";
import { getConnection, listConnections } from "./inference/connections.js";
import { concurrentManagedProviderContextIsActive } from "./platform-proxy/concurrent-request-context.js";
import { PLATFORM_PROVIDER_META } from "./platform-proxy/constants.js";
import { initializeProviders, listProviders } from "./registry.js";
import { resolveProviderFromConnection } from "./registry.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolUseContent,
} from "./types.js";

const log = getLogger("provider-send-message");

export interface ConfiguredProviderResult {
  provider: Provider;
  configuredProviderName: string;
}

export interface RequiredProviderConnection {
  name: string;
  provider: string;
  authType: "oauth_subscription";
  model: string;
}

export type ConfiguredProviderOptions = Pick<
  ResolveCallSiteOpts,
  "forceOverrideProfile" | "overrideProfile" | "selectionSeed"
> & {
  /**
   * Resolve one exact personal connection and model without auto-selection or
   * fallback. Intended for resumable jobs whose provider identity is part of
   * their durable contract.
   */
  requiredConnection?: RequiredProviderConnection;
};

export class RequiredProviderConnectionError extends Error {
  constructor(
    readonly reason:
      | "not_found"
      | "provider_mismatch"
      | "auth_mismatch"
      | "model_incompatible",
    message: string,
  ) {
    super(message);
    this.name = "RequiredProviderConnectionError";
  }
}

/**
 * Cached promise for the lazy initialization path inside
 * `resolveConfiguredProvider`. When multiple concurrent callers enter before
 * providers are initialized, they all await the same promise instead of
 * each triggering a redundant `initializeProviders` call.
 */
let lazyInitPromise: Promise<void> | null = null;

async function resolveConcurrentManagedProvider(
  callSite: LLMCallSite,
  config: ReturnType<typeof getConfig>,
  opts: ConfiguredProviderOptions,
): Promise<ConfiguredProviderResult | null> {
  if (opts.requiredConnection || !concurrentManagedProviderContextIsActive()) {
    return null;
  }

  const resolved = resolveCallSiteConfig(callSite, config.llm, opts);
  const providerMeta = PLATFORM_PROVIDER_META[resolved.provider];
  if (!providerMeta?.managed) {
    log.warn(
      { callSite, provider: resolved.provider },
      "Concurrent managed inference rejected a non-managed provider",
    );
    return null;
  }

  const connection: ProviderConnection = {
    name: `${resolved.provider}-managed`,
    provider: resolved.provider,
    auth: { type: "platform" },
    label: providerMeta.name,
    baseUrl: null,
    models: null,
    createdAt: 0,
    updatedAt: 0,
    isManaged: true,
  };
  const provider = await resolveProviderFromConnection(connection, config, {
    model: resolved.model,
  });
  if (!provider) return null;
  return {
    provider: new CallSiteConfiguredProvider(provider, callSite, opts),
    configuredProviderName: resolved.provider,
  };
}

export class CallSiteConfiguredProvider implements Provider {
  public readonly name: string;
  public readonly tokenEstimationProvider?: string;
  private readonly routingOptions: ConfiguredProviderOptions;

  constructor(
    private readonly inner: Provider,
    private readonly callSite: LLMCallSite,
    routingOptionsOrOverrideProfile: ConfiguredProviderOptions | string = {},
    forceOverrideProfile?: boolean,
    selectionSeed?: string,
  ) {
    this.routingOptions =
      typeof routingOptionsOrOverrideProfile === "string"
        ? {
            overrideProfile: routingOptionsOrOverrideProfile,
            ...(forceOverrideProfile === undefined
              ? {}
              : { forceOverrideProfile }),
            ...(selectionSeed === undefined ? {} : { selectionSeed }),
          }
        : routingOptionsOrOverrideProfile;
    this.name = inner.name;
    this.tokenEstimationProvider = inner.tokenEstimationProvider;
  }

  sendMessage(
    messages: Message[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const config = options?.config;
    return this.inner.sendMessage(messages, {
      ...options,
      config: {
        ...config,
        callSite: config?.callSite ?? this.callSite,
        ...(this.routingOptions.requiredConnection
          ? { model: this.routingOptions.requiredConnection.model }
          : {}),
        ...(config?.forceOverrideProfile === undefined &&
        this.routingOptions.forceOverrideProfile !== undefined
          ? { forceOverrideProfile: this.routingOptions.forceOverrideProfile }
          : {}),
        ...(config?.overrideProfile === undefined &&
        this.routingOptions.overrideProfile !== undefined
          ? { overrideProfile: this.routingOptions.overrideProfile }
          : {}),
        ...(config?.selectionSeed === undefined &&
        this.routingOptions.selectionSeed !== undefined
          ? { selectionSeed: this.routingOptions.selectionSeed }
          : {}),
      },
    });
  }
}

/**
 * Resolve the configured provider with full selection metadata.
 * If providers haven't been initialized yet (e.g. non-daemon code paths),
 * performs a one-shot `initializeProviders(getConfig())`.
 *
 * The provider name is sourced from
 * `resolveCallSiteConfig(callSite, config.llm, opts).provider` — i.e. the
 * unified `llm` block drives selection. The `callSite` argument is required
 * so the resolver can layer per-call-site overrides; pass the closest
 * matching call-site identifier from `LLMCallSiteEnum` when adding a new
 * caller. Pass `opts.overrideProfile` to apply a per-call ad-hoc profile
 * override (e.g. a per-conversation pinned profile) on top of any workspace
 * `activeProfile`.
 *
 * Returns `null` when no providers are available at all.
 */
export async function resolveConfiguredProvider(
  callSite: LLMCallSite,
  opts: ConfiguredProviderOptions = {},
): Promise<ConfiguredProviderResult | null> {
  const config = getConfig();
  const requiredConnection = opts.requiredConnection;

  if (isConcurrentServiceRuntime()) {
    return resolveConcurrentManagedProvider(callSite, config, opts);
  }

  if (!requiredConnection && listProviders().length === 0) {
    if (!lazyInitPromise) {
      lazyInitPromise = initializeProviders(config).finally(() => {
        lazyInitPromise = null;
      });
    }
    try {
      await lazyInitPromise;
    } catch {
      return null;
    }
  }

  const resolved = requiredConnection
    ? undefined
    : resolveCallSiteConfig(callSite, config.llm, opts);
  const inferenceProvider = requiredConnection?.provider ?? resolved!.provider;
  const resolvedModel = requiredConnection?.model ?? resolved!.model;
  let connectionName =
    requiredConnection?.name ?? resolved!.provider_connection;

  if (requiredConnection) {
    const connection = getConnection(getDb(), requiredConnection.name);
    if (!connection) {
      throw new RequiredProviderConnectionError(
        "not_found",
        `Required provider connection "${requiredConnection.name}" is not configured.`,
      );
    }
    if (connection.provider !== requiredConnection.provider) {
      throw new RequiredProviderConnectionError(
        "provider_mismatch",
        `Required provider connection "${requiredConnection.name}" is not an ${requiredConnection.provider} connection.`,
      );
    }
    if (connection.auth.type !== requiredConnection.authType) {
      throw new RequiredProviderConnectionError(
        "auth_mismatch",
        `Required provider connection "${requiredConnection.name}" does not use ${requiredConnection.authType} authentication.`,
      );
    }
    if (
      !isConnectionCompatibleWithModel(connection, requiredConnection.model)
    ) {
      throw new RequiredProviderConnectionError(
        "model_incompatible",
        `Model "${requiredConnection.model}" is not compatible with provider connection "${requiredConnection.name}".`,
      );
    }
  }

  // Connection-aware path: every dispatch goes through `provider_connection`.
  // The boot-time backfill ensures every profile has one in production.
  // When unset (profile set provider without a connection, test envs that
  // skip backfill, freshly-installed configs not yet backfilled, or users
  // who manually cleared the field), try to auto-resolve a personal connection
  // from the provider before falling back to null. Managed transport must be
  // selected by an explicit profile binding.
  if (!connectionName) {
    if (inferenceProvider) {
      try {
        const candidates = listConnections(getDb(), {
          provider: inferenceProvider,
        });
        const active = candidates.find(
          (candidate) =>
            isPersonalProviderConnection(candidate) &&
            isConnectionCompatibleWithModel(candidate, resolvedModel),
        );
        if (active) {
          connectionName = active.name;
        } else {
          const incompatMsg = describeSubscriptionModelIncompatibility(
            candidates,
            resolvedModel,
          );
          if (incompatMsg) {
            log.warn(
              { callSite, inferenceProvider, model: resolvedModel },
              incompatMsg,
            );
          }
        }
      } catch {
        // DB not available — fall through to the existing null-return path.
      }
    }
    if (!connectionName) {
      log.debug(
        { callSite, inferenceProvider },
        "resolveCallSiteConfig yielded no provider_connection — returning null so callsite can fall back",
      );
      return null;
    }
  }

  const connectionProvider = await tryResolveProviderForConnectionName(
    connectionName,
    config,
    inferenceProvider,
    resolvedModel,
  );
  if (!connectionProvider) {
    // Soft credential failure — the connection resolved to no usable
    // adapter (credential missing, transient auth failure, etc.).
    // Callers handle null as "no provider available" rather than crash.
    return null;
  }
  return {
    provider: new CallSiteConfiguredProvider(
      connectionProvider,
      callSite,
      opts,
    ),
    configuredProviderName: inferenceProvider,
  };
}

/**
 * Resolve the configured provider through the registry.
 * Thin wrapper around `resolveConfiguredProvider()` for callsites
 * that only need the Provider instance.
 *
 * `callSite` is required — see `resolveConfiguredProvider`. Returns `null`
 * when no providers are available.
 */
export async function getConfiguredProvider(
  callSite: LLMCallSite,
  opts: ConfiguredProviderOptions = {},
): Promise<Provider | null> {
  const result = await resolveConfiguredProvider(callSite, opts);
  return result?.provider ?? null;
}

/**
 * Create an AbortSignal that fires after `ms` milliseconds.
 * Returns the signal and a cleanup function to clear the timer.
 */
export function createTimeout(ms: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

/**
 * Extract the first text block's text from a ProviderResponse.
 * Returns empty string if no text block is found.
 */
export function extractText(response: ProviderResponse): string {
  const block = response.content.find(
    (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
  );
  return block?.text?.trim() ?? "";
}

/**
 * Extract all text blocks from a ProviderResponse and join them.
 */
export function extractAllText(response: ProviderResponse): string {
  const parts = response.content
    .filter(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
    )
    .map((b) => b.text);
  // Join consecutive text blocks with a space, but skip the separator when
  // either side already has whitespace (avoids double-spacing).
  let result = parts[0] ?? "";
  for (let i = 1; i < parts.length; i++) {
    const prev = result[result.length - 1];
    const next = parts[i][0];
    if (
      prev &&
      next &&
      prev !== " " &&
      prev !== "\n" &&
      prev !== "\t" &&
      next !== " " &&
      next !== "\n" &&
      next !== "\t"
    ) {
      result += " ";
    }
    result += parts[i];
  }
  return result;
}

/**
 * Find the first tool_use block in a ProviderResponse.
 */
export function extractToolUse(
  response: ProviderResponse,
): ToolUseContent | undefined {
  return response.content.find(
    (b): b is ToolUseContent => b.type === "tool_use",
  );
}

/**
 * Build a single user message in the provider Message format.
 */
export function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}
