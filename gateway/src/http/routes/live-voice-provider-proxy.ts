import { buildUpstreamUrl } from "@vellumai/assistant-client";

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";

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
    headers.set("Authorization", `Bearer ${mintServiceToken()}`);
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
