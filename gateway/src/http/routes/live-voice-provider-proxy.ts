import { buildUpstreamUrl } from "@vellumai/assistant-client";

import {
  mintExchangeToken,
  mintServiceToken,
  validateEdgeToken,
} from "../../auth/token-exchange.js";
import { validatePooledWorkerLeaseClaims } from "../../auth/pooled-worker-lease.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { installRuntimeWorkerLeaseAuthority } from "../../runtime-worker-lease-authority.js";

const log = getLogger("live-voice-provider-proxy");

export function createLiveVoiceProviderProxyHandler(config: GatewayConfig) {
  return async (req: Request): Promise<Response> => {
    const incoming = new URL(req.url);
    const upstream = buildUpstreamUrl(
      config.assistantRuntimeBaseUrl,
      "/v1/live-voice/providers/chat/completions",
      incoming.search,
    );
    const headers = new Headers();
    const dispatcherAuthorization = req.headers.get(
      "x-worklin-runtime-authorization",
    );
    const runtimeAuthorization = authorizeLiveVoiceRuntimeCallback(
      dispatcherAuthorization,
      config,
    );
    if (runtimeAuthorization instanceof Response) {
      return runtimeAuthorization;
    }
    headers.set("Authorization", `Bearer ${runtimeAuthorization}`);
    headers.set(
      "Content-Type",
      req.headers.get("content-type") ?? "application/json",
    );
    const providerAuthorization = req.headers.get("authorization");
    if (providerAuthorization) {
      headers.set("X-Worklin-Provider-Authorization", providerAuthorization);
    }

    try {
      const body = await req.arrayBuffer();
      const response = await fetchImpl(upstream, {
        method: "POST",
        headers,
        body,
        signal: req.signal,
      });
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("content-length");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      log.error({ error }, "Managed voice provider callback proxy failed");
      return Response.json(
        { error: { message: "Worklin voice is temporarily unavailable" } },
        { status: 502 },
      );
    }
  };
}

export function authorizeLiveVoiceRuntimeCallback(
  authorization: string | null,
  config: GatewayConfig,
): string | Response {
  if (!authorization) {
    return config.runtimeWorkerStackId
      ? new Response("Unauthorized", { status: 401 })
      : mintServiceToken();
  }
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = validateEdgeToken(authorization.slice(7));
  if (!result.ok) {
    return new Response("Unauthorized", { status: 401 });
  }
  const lease = validatePooledWorkerLeaseClaims(
    result.claims,
    config.runtimeWorkerStackId,
  );
  if (!lease.ok || !lease.claim || !config.runtimeWorkerLeaseAuthorityFile) {
    return new Response("Forbidden", { status: 403 });
  }
  try {
    installRuntimeWorkerLeaseAuthority(
      config.runtimeWorkerLeaseAuthorityFile,
      lease.claim,
    );
  } catch {
    return new Response("Worker lease authority unavailable", {
      status: 503,
    });
  }
  return mintExchangeToken(result.claims, "gateway_service_v1");
}
