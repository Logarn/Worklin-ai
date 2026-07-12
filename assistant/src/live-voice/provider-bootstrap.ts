import { randomUUID } from "node:crypto";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import type { VoiceEngineId } from "../config/schemas/voice.js";
import { credentialKey } from "../security/credential-key.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import {
  createManagedVoiceSession,
  releaseManagedVoiceSession,
} from "./provider-session.js";

const HUME_TOKEN_URL = "https://api.hume.ai/oauth2-cc/token";
const HUME_CHAT_URL = "wss://api.hume.ai/v0/evi/chat";
const ELEVENLABS_CONVERSATION_TOKEN_URL =
  "https://api.elevenlabs.io/v1/convai/conversation/token";

export type VoiceSessionConnection =
  | { transport: "native" }
  | {
      transport: "hume";
      websocketUrl: string;
      sessionToken: string;
      voiceId?: string;
    }
  | {
      transport: "elevenlabs";
      conversationToken: string;
      sessionToken: string;
      voiceId?: string;
    };

export interface VoiceSessionBootstrapResult {
  sessionId: string;
  conversationId: string;
  engine: VoiceEngineId;
  expiresAt: string;
  connection: VoiceSessionConnection;
}

export class VoiceBootstrapError extends Error {
  constructor(
    readonly code:
      | "disabled"
      | "forbidden"
      | "busy"
      | "not_configured"
      | "provider_error",
    message: string,
    readonly activeSessionId?: string,
  ) {
    super(message);
    this.name = "VoiceBootstrapError";
  }
}

export async function bootstrapVoiceSession(input: {
  assistantId: string;
  conversationId?: string;
  actorId: string;
  organizationId?: string;
  engine?: VoiceEngineId;
  fetchImpl?: typeof fetch;
}): Promise<VoiceSessionBootstrapResult> {
  const config = getConfig();
  if (!isAssistantFeatureFlagEnabled("voice-mode", config)) {
    throw new VoiceBootstrapError("disabled", "Voice mode is not enabled");
  }

  const engine = input.engine ?? config.services.voice.engine;
  const sessionId = randomUUID();
  const conversationId = input.conversationId?.trim() || sessionId;
  if (engine === "native") {
    return {
      sessionId,
      conversationId,
      engine,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      connection: { transport: "native" },
    };
  }

  enforcePilotAllowlist(config.services.voice.pilotAllowlist, input.actorId);
  let managed;
  try {
    managed = createManagedVoiceSession({
      sessionId,
      assistantId: input.assistantId,
      conversationId,
      actorId: input.actorId,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      engine,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("voice_session_busy:")) {
      const activeSessionId = message.slice("voice_session_busy:".length);
      throw new VoiceBootstrapError(
        "busy",
        "Another voice session is active",
        activeSessionId,
      );
    }
    throw error;
  }

  try {
    const connection =
      engine === "hume"
        ? await bootstrapHume(managed.token, input.fetchImpl ?? fetch)
        : await bootstrapElevenLabs(managed.token, input.fetchImpl ?? fetch);
    return {
      sessionId,
      conversationId,
      engine,
      expiresAt: new Date(managed.binding.expiresAtMs).toISOString(),
      connection,
    };
  } catch (error) {
    releaseManagedVoiceSession(sessionId, input.actorId);
    throw error;
  }
}

function enforcePilotAllowlist(allowlist: string[], actorId: string): void {
  if (allowlist.includes("*") || allowlist.includes(actorId)) return;
  throw new VoiceBootstrapError(
    "forbidden",
    "Managed voice is limited to the private pilot",
  );
}

async function bootstrapHume(
  sessionToken: string,
  fetchImpl: typeof fetch,
): Promise<VoiceSessionConnection> {
  const [apiKey, secretKey] = await Promise.all([
    getSecureKeyAsync(credentialKey("hume", "api_key")),
    getSecureKeyAsync(credentialKey("hume", "secret_key")),
  ]);
  const providerConfig = getConfig().services.voice.providers.hume;
  if (!apiKey || !secretKey || !providerConfig.configId.trim()) {
    throw new VoiceBootstrapError(
      "not_configured",
      "Hume requires an API key, secret key, and EVI config ID",
    );
  }

  const response = await fetchImpl(HUME_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:${secretKey}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) {
    throw new VoiceBootstrapError(
      "provider_error",
      `Hume access-token request failed (${response.status})`,
    );
  }
  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new VoiceBootstrapError(
      "provider_error",
      "Hume access-token response was malformed",
    );
  }
  const url = new URL(HUME_CHAT_URL);
  url.searchParams.set("access_token", body.access_token);
  url.searchParams.set("config_id", providerConfig.configId.trim());
  url.searchParams.set("audio_encoding", "linear16");
  url.searchParams.set("audio_channels", "1");
  url.searchParams.set("audio_sample_rate", "16000");
  url.searchParams.set("verbose_transcription", "true");
  return {
    transport: "hume",
    websocketUrl: url.toString(),
    sessionToken,
    ...(providerConfig.voiceId.trim()
      ? { voiceId: providerConfig.voiceId.trim() }
      : {}),
  };
}

async function bootstrapElevenLabs(
  sessionToken: string,
  fetchImpl: typeof fetch,
): Promise<VoiceSessionConnection> {
  const apiKey = await getSecureKeyAsync(
    credentialKey("elevenlabs", "api_key"),
  );
  const providerConfig = getConfig().services.voice.providers.elevenlabs;
  if (!apiKey || !providerConfig.agentId.trim()) {
    throw new VoiceBootstrapError(
      "not_configured",
      "ElevenLabs requires an API key and agent ID",
    );
  }
  const url = new URL(ELEVENLABS_CONVERSATION_TOKEN_URL);
  url.searchParams.set("agent_id", providerConfig.agentId.trim());
  const response = await fetchImpl(url, {
    headers: { "xi-api-key": apiKey },
  });
  if (!response.ok) {
    throw new VoiceBootstrapError(
      "provider_error",
      `ElevenLabs signed-URL request failed (${response.status})`,
    );
  }
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string" || !body.token) {
    throw new VoiceBootstrapError(
      "provider_error",
      "ElevenLabs conversation-token response was malformed",
    );
  }
  return {
    transport: "elevenlabs",
    conversationToken: body.token,
    sessionToken,
    ...(providerConfig.voiceId.trim()
      ? { voiceId: providerConfig.voiceId.trim() }
      : {}),
  };
}
