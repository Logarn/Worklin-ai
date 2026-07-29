/**
 * Provider wrapper that routes each `sendMessage` call to a different
 * underlying provider transport when the per-call `options.config.callSite`
 * resolves to a profile that names a `provider_connection` distinct from
 * the default's.
 *
 * Without this wrapper the conversation-level provider transport is fixed at
 * construction time, so a per-call-site `llm.callSites.<id>.provider`
 * override only affects the request *metadata* the downstream client sees —
 * the actual HTTP transport still belongs to `llm.default.provider`. That
 * means routing decisions like "send `memoryRetrieval` calls to OpenAI even
 * though the main agent runs on Anthropic" silently fail.
 *
 * `CallSiteRoutingProvider` consults `resolveCallSiteConfig` per call. When
 * the resolved profile names a `provider_connection`, the wrapper resolves
 * that connection and delegates the call to its bound Provider. Other
 * Provider interface surface area (`name`, `tokenEstimationProvider`) is
 * delegated to the default so wrappers further out (e.g. `RateLimitProvider`)
 * still see a stable identity.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import { getDb } from "../memory/db-connection.js";
import {
  describeSubscriptionModelIncompatibility,
  isConnectionCompatibleWithModel,
} from "./connection-model-compat.js";
import {
  ConnectionResolutionError,
  type ConnectionResolutionRequirements,
  isPersonalProviderConnection,
  tryResolveProviderForConnectionName,
} from "./connection-resolution.js";
import { listConnections } from "./inference/connections.js";
import type { ProvidersConfig } from "./registry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "./types.js";

type LlmConfig = ReturnType<typeof getConfig>["llm"];

function profileRequiresPersonalConnection(
  llm: LlmConfig,
  profileName: string | undefined,
): boolean | undefined {
  if (!profileName) return undefined;
  const profile = llm.profiles?.[profileName];
  return profile ? profile.source !== "managed" : undefined;
}

function callSiteRequiresPersonalConnection(
  callSite: NonNullable<NonNullable<SendMessageOptions["config"]>["callSite"]>,
  llm: LlmConfig,
  options: SendMessageOptions,
): boolean {
  const site = llm.callSites?.[callSite];
  const overrideProfile = profileRequiresPersonalConnection(
    llm,
    options.config?.overrideProfile,
  );
  const activeProfile = profileRequiresPersonalConnection(
    llm,
    llm.activeProfile,
  );
  const siteProfile = profileRequiresPersonalConnection(llm, site?.profile);
  const hasDirectSelection = site?.provider != null || site?.model != null;

  if (callSite === "mainAgent") {
    return (
      overrideProfile ??
      activeProfile ??
      (hasDirectSelection ? true : siteProfile) ??
      false
    );
  }

  if (
    options.config?.forceOverrideProfile === true &&
    overrideProfile !== undefined
  ) {
    return overrideProfile;
  }
  return (
    (hasDirectSelection ? true : siteProfile) ??
    overrideProfile ??
    activeProfile ??
    false
  );
}

export class CallSiteRoutingProvider implements Provider {
  public readonly tokenEstimationProvider?: string;

  // Per-call async context that tracks which provider is currently executing.
  // Using AsyncLocalStorage instead of a plain instance field means concurrent
  // sendMessage calls (e.g. the main agent turn and a title-generation call
  // both in-flight at the same time on the same provider instance) each see
  // their own value — no clobbering, no premature clear.
  //
  // During sendMessage, emitLlmCallStartedIfNeeded reads provider.name on the
  // first text_delta (before the response completes). The getter below returns
  // the async-context value so streaming trace events carry the routed
  // provider's name, not the default's.
  private readonly _activeProviderContext = new AsyncLocalStorage<string>();

  get name(): string {
    return this._activeProviderContext.getStore() ?? this.defaultProvider.name;
  }

  constructor(
    private readonly defaultProvider: Provider,
    /**
     * Async hook invoked when the resolved profile names a
     * `provider_connection`. Returning a Provider routes the call through
     * that connection's auth; returning null signals a soft credential
     * failure (no usable adapter) and the wrapper falls back to the
     * default Provider for graceful per-call degradation. Hard config
     * errors (lookup_failed / not_found / provider_mismatch) throw
     * `ConnectionResolutionError` and propagate to the caller — those
     * are misconfigurations that need to be fixed, not silently routed
     * around.
     *
     * `expectedProvider` is the provider name the resolved profile
     * declared. The hook verifies the connection's provider matches
     * and throws on mismatch.
     *
     * `model` is the resolved call-site model, threaded through so the
     * connection lookup can gate `oauth_subscription` (Codex) connections
     * by model compatibility.
     *
     * `requirements.requirePersonal` prevents direct/user routing from
     * resolving through platform auth or another fallback transport.
     */
    private readonly resolveByConnection: (
      connectionName: string,
      expectedProvider: string,
      model: string | undefined,
      requirements: ConnectionResolutionRequirements,
    ) => Promise<Provider | null>,
  ) {
    this.tokenEstimationProvider = defaultProvider.tokenEstimationProvider;
  }

  async sendMessage(
    messages: Message[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const target = await this.selectProvider(options);
    const isRouted = target !== this.defaultProvider;

    const doSend = async (): Promise<ProviderResponse> => {
      const response = await target.sendMessage(messages, options);
      // Also stamp actualProvider on the response so that handleUsage /
      // llm_call_finished (which read event.actualProvider, not provider.name)
      // attribute the call to the right provider.
      if (isRouted && response.actualProvider == null) {
        return { ...response, actualProvider: target.name };
      }
      return response;
    };

    // Run inside the async context so that any code reading provider.name
    // during streaming (e.g. emitLlmCallStartedIfNeeded on text_delta) sees
    // the routed provider's name for this specific call, not the default.
    return isRouted
      ? this._activeProviderContext.run(target.name, doSend)
      : doSend();
  }

  /**
   * Pick the provider to route this call through.
   *
   * Resolution order:
   *   1. No callSite → default provider (legacy short-circuit; no
   *      resolution work needed).
   *   2. Resolved profile names a `provider_connection` → resolve through
   *      that connection's auth. Hard config errors propagate as throws.
   *      Soft credential failures fall back to the default Provider so
   *      a transient credential blip does not take a conversation
   *      offline.
   *   3. Resolved profile's `provider` matches the default's name → reuse
   *      the default provider instance (no connection-aware lookup
   *      needed; the default IS the connection-aware route).
   *   4. Resolved profile's `provider` differs from the default but no
   *      `provider_connection` is set → throw. This is a configuration
   *      bug: alternate-provider routing requires a connection.
   */
  private async selectProvider(
    options?: SendMessageOptions,
  ): Promise<Provider> {
    const callSite = options?.config?.callSite;
    if (!callSite) return this.defaultProvider;

    const overrideProfile = options?.config?.overrideProfile;
    // Forward `forceOverrideProfile` and the per-conversation mix seed so
    // transport selection resolves the same profile/arm as wire-param
    // normalization in `retry.ts` — otherwise a forced profile (or a mix)
    // spanning providers could route the transport differently than the
    // request params.
    const forceOverrideProfile = options?.config?.forceOverrideProfile;
    const selectionSeed = options?.config?.selectionSeed;
    const llm = getConfig().llm;
    const resolved = resolveCallSiteConfig(callSite, llm, {
      overrideProfile,
      forceOverrideProfile,
      selectionSeed,
    });
    const requirePersonal = callSiteRequiresPersonalConnection(
      callSite,
      llm,
      options,
    );

    const connectionName = resolved.provider_connection;

    // An unpinned direct/user selection may resolve only through a matching
    // personal connection. Try each compatible candidate until one proves
    // runnable; inventory order is never permission to use platform auth.
    if (!connectionName && requirePersonal) {
      let autoResolveCandidates:
        | import("./inference/auth.js").ProviderConnection[]
        | undefined;
      try {
        autoResolveCandidates = listConnections(getDb(), {
          provider: resolved.provider,
        });
        const personalCandidates = autoResolveCandidates.filter(
          isPersonalProviderConnection,
        );
        const compatibleCandidates = personalCandidates.filter((candidate) =>
          isConnectionCompatibleWithModel(candidate, resolved.model),
        );
        for (const candidate of compatibleCandidates) {
          const provider = await this.resolveByConnection(
            candidate.name,
            resolved.provider,
            resolved.model,
            { requirePersonal: true },
          );
          if (provider) return provider;
        }
        const incompatMsg = describeSubscriptionModelIncompatibility(
          personalCandidates,
          resolved.model,
        );
        if (incompatMsg) {
          throw new ConnectionResolutionError(
            "<resolved-callsite>",
            "model_incompatible",
            incompatMsg,
          );
        }
        if (compatibleCandidates.length > 0) {
          throw new ConnectionResolutionError(
            "<resolved-callsite>",
            "unavailable",
            `call-site "${callSite}" has no runnable personal connection for provider "${resolved.provider}"`,
          );
        }
      } catch (error) {
        if (error instanceof ConnectionResolutionError) throw error;
        // DB not available — fall through to the fail-closed error below.
      }

      throw new ConnectionResolutionError(
        "<resolved-callsite>",
        "personal_connection_required",
        `call-site "${callSite}" requires a matching runnable personal connection for provider "${resolved.provider}"`,
      );
    }

    if (connectionName) {
      const connectionProvider = await this.resolveByConnection(
        connectionName,
        resolved.provider,
        resolved.model,
        { requirePersonal },
      );
      if (connectionProvider) return connectionProvider;
      if (requirePersonal) {
        throw new ConnectionResolutionError(
          connectionName,
          "unavailable",
          `call-site "${callSite}" selected personal connection "${connectionName}", but its credentials are unavailable`,
        );
      }
      return this.defaultProvider;
    }

    if (resolved.provider === this.defaultProvider.name) {
      return this.defaultProvider;
    }

    throw new ConnectionResolutionError(
      "<resolved-callsite>",
      "missing_connection",
      `call-site "${callSite}" resolves to provider "${resolved.provider}" but no provider_connection is set — alternate-provider routing requires a connection`,
    );
  }
}

/**
 * Wrap a base Provider with `CallSiteRoutingProvider` configured to route
 * `provider_connection` references through the shared connection-resolution
 * helper.
 *
 * `config` is threaded through to the connection lookup so the resolved
 * connection's auth can read provider-config metadata (e.g. timeouts, model
 * names).
 */
export function wrapWithCallSiteRouting(
  base: Provider,
  config: ProvidersConfig,
): Provider {
  return new CallSiteRoutingProvider(
    base,
    (connectionName, expectedProvider, model, requirements) =>
      tryResolveProviderForConnectionName(
        connectionName,
        config,
        expectedProvider,
        model,
        requirements,
      ),
  );
}
