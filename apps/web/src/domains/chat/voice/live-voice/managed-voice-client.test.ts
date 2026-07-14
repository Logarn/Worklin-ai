import { beforeEach, describe, expect, mock, test } from "bun:test";

let sessionOptions: Record<string, unknown> | null = null;
let endSessionCount = 0;

mock.module("@elevenlabs/client", () => ({
  Conversation: {
    startSession: mock(async (options: Record<string, unknown>) => {
      sessionOptions = options;
      return {
        endSession: async () => {
          endSessionCount += 1;
        },
        getInputVolume: () => 0,
        getOutputVolume: () => 0,
        setMicMuted: () => undefined,
      };
    }),
  },
}));

mock.module("@/domains/chat/voice/live-voice/bootstrap", () => ({
  bindVoiceProviderConversation: mock(async () => undefined),
}));

const { ManagedVoiceChannelClient } = await import(
  "@/domains/chat/voice/live-voice/managed-voice-client"
);

describe("ManagedVoiceChannelClient ElevenLabs disconnects", () => {
  beforeEach(() => {
    sessionOptions = null;
    endSessionCount = 0;
  });

  test("surfaces an unexpected provider disconnect instead of silently closing", async () => {
    const client = new ManagedVoiceChannelClient(
      {
        sessionId: "session-1",
        conversationId: "conversation-1",
        engine: "elevenlabs",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        connection: {
          transport: "elevenlabs",
          conversationToken: "short-lived-token",
          sessionToken: "short-lived-session-token",
        },
      },
      { assistantId: "assistant-1" },
    );
    const errors: Array<{ reason: string; message: string }> = [];
    let closedCount = 0;
    client.on("error", (error) => errors.push(error));
    client.on("closed", () => closedCount++);

    await client.connect({ assistantId: "assistant-1" });
    const onDisconnect = sessionOptions?.onDisconnect as
      | ((details: {
          reason: "agent";
          context: { type: string; reason: string };
        }) => void)
      | undefined;
    onDisconnect?.({
      reason: "agent",
      context: { type: "close", reason: "agent disconnected" },
    });

    expect(errors).toEqual([
      {
        reason: "connection-failed",
        message:
          "ElevenLabs ended the voice session: agent disconnected",
      },
    ]);
    expect(closedCount).toBe(0);

    client.close();
    expect(closedCount).toBe(1);
    expect(endSessionCount).toBe(1);
  });

  test("uses the provider error message when ElevenLabs reports one", async () => {
    const client = new ManagedVoiceChannelClient(
      {
        sessionId: "session-2",
        conversationId: "conversation-2",
        engine: "elevenlabs",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        connection: {
          transport: "elevenlabs",
          conversationToken: "short-lived-token",
          sessionToken: "short-lived-session-token",
        },
      },
      { assistantId: "assistant-1" },
    );
    const errors: string[] = [];
    client.on("error", (error) => errors.push(error.message));

    await client.connect({ assistantId: "assistant-1" });
    const onDisconnect = sessionOptions?.onDisconnect as
      | ((details: {
          reason: "error";
          message: string;
          context: { type: string };
        }) => void)
      | undefined;
    onDisconnect?.({
      reason: "error",
      message: "upstream failed",
      context: { type: "connection_state_changed" },
    });

    expect(errors).toEqual(["upstream failed"]);
    client.close();
  });
});
