const ELEVENLABS_SPEECH_ENGINE_URL =
  "https://api.elevenlabs.io/v1/speech-engine";

export type ElevenLabsSpeechEngineDiagnostic = {
  speechEngineId: string;
  upstreamUrl: string;
  requestHeadersConfigured: boolean;
  recordVoice: boolean | null;
  deleteAudio: boolean | null;
  zeroRetentionMode: boolean | null;
};

export class ElevenLabsSpeechEngineResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElevenLabsSpeechEngineResourceError";
  }
}

export async function inspectElevenLabsSpeechEngine(input: {
  apiKey: string;
  speechEngineId: string;
  fetchImpl?: typeof fetch;
}): Promise<ElevenLabsSpeechEngineDiagnostic> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const speechEngineId = input.speechEngineId.trim();
  if (!speechEngineId) {
    throw new ElevenLabsSpeechEngineResourceError(
      "ElevenLabs Speech Engine ID is missing",
    );
  }
  let response: Response;
  try {
    response = await fetchImpl(
      `${ELEVENLABS_SPEECH_ENGINE_URL}/${encodeURIComponent(speechEngineId)}`,
      { headers: { "xi-api-key": input.apiKey } },
    );
  } catch {
    throw new ElevenLabsSpeechEngineResourceError(
      "ElevenLabs Speech Engine lookup request failed",
    );
  }
  if (!response.ok) {
    throw new ElevenLabsSpeechEngineResourceError(
      `ElevenLabs Speech Engine lookup failed (${response.status})`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ElevenLabsSpeechEngineResourceError(
      "ElevenLabs Speech Engine response was malformed",
    );
  }
  if (!body || typeof body !== "object") {
    throw new ElevenLabsSpeechEngineResourceError(
      "ElevenLabs Speech Engine response was malformed",
    );
  }

  const resource = body as Record<string, unknown>;
  if (resource.speech_engine_id !== speechEngineId) {
    throw new ElevenLabsSpeechEngineResourceError(
      "ElevenLabs Speech Engine response did not match the configured resource",
    );
  }
  const speechEngine = objectValue(resource.speech_engine);
  const upstreamUrl = safeUpstreamUrl(speechEngine?.ws_url);
  const privacy = objectValue(resource.privacy);

  return {
    speechEngineId,
    upstreamUrl,
    requestHeadersConfigured:
      Object.keys(objectValue(speechEngine?.request_headers) ?? {}).length > 0,
    recordVoice: booleanValue(privacy?.record_voice),
    deleteAudio: booleanValue(privacy?.delete_audio),
    zeroRetentionMode: booleanValue(privacy?.zero_retention_mode),
  };
}

function safeUpstreamUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ElevenLabsSpeechEngineResourceError(
      "ElevenLabs Speech Engine has no upstream WebSocket URL",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ElevenLabsSpeechEngineResourceError(
      "ElevenLabs Speech Engine upstream URL is invalid",
    );
  }
  if (url.protocol !== "wss:" || url.username || url.password) {
    throw new ElevenLabsSpeechEngineResourceError(
      "ElevenLabs Speech Engine upstream must use a credential-free wss URL",
    );
  }
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
