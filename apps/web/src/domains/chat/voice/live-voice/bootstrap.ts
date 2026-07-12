import { client } from "@/generated/api/client.gen";
import { assertHasResponse } from "@/utils/api-errors";

export type VoiceEngineId = "native" | "hume" | "elevenlabs";

export type VoiceSessionBootstrap = {
  sessionId: string;
  conversationId: string;
  engine: VoiceEngineId;
  expiresAt: string;
  connection:
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
};

export class VoiceBootstrapRequestError extends Error {
  constructor(readonly status: number) {
    super(`Voice session bootstrap failed (${status})`);
    this.name = "VoiceBootstrapRequestError";
  }
}

function isBootstrap(value: unknown): value is VoiceSessionBootstrap {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sessionId === "string" &&
    typeof candidate.conversationId === "string" &&
    (candidate.engine === "native" ||
      candidate.engine === "hume" ||
      candidate.engine === "elevenlabs") &&
    !!candidate.connection &&
    typeof candidate.connection === "object"
  );
}

export async function bootstrapVoiceSession(input: {
  assistantId: string;
  conversationId?: string;
}): Promise<VoiceSessionBootstrap> {
  const { data, error, response } = await client.post({
    url: "/v1/assistants/{assistant_id}/live-voice/sessions",
    path: { assistant_id: input.assistantId },
    body: {
      assistantId: input.assistantId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to start voice session");
  if (!response.ok || !isBootstrap(data)) {
    throw new VoiceBootstrapRequestError(response.status);
  }
  return data;
}

export async function releaseVoiceSession(input: {
  assistantId: string;
  sessionId: string;
}): Promise<void> {
  await client.delete({
    url: "/v1/assistants/{assistant_id}/live-voice/sessions/{session_id}",
    path: {
      assistant_id: input.assistantId,
      session_id: input.sessionId,
    },
    throwOnError: false,
  });
}

export async function bindVoiceProviderConversation(input: {
  assistantId: string;
  sessionId: string;
  providerConversationId: string;
  sessionToken: string;
}): Promise<void> {
  const { response, error } = await client.post({
    url: "/v1/assistants/{assistant_id}/live-voice/sessions/{session_id}/provider-conversation",
    path: {
      assistant_id: input.assistantId,
      session_id: input.sessionId,
    },
    body: {
      providerConversationId: input.providerConversationId,
      sessionToken: input.sessionToken,
    },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to bind voice provider session");
}
