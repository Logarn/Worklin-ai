import { describe, expect, mock, test } from "bun:test";

import {
  ElevenLabsSpeechEngineResourceError,
  inspectElevenLabsSpeechEngine,
} from "../elevenlabs-speech-engine-resource.js";

describe("ElevenLabs Speech Engine resource inspection", () => {
  test("rejects a missing resource ID before contacting ElevenLabs", async () => {
    const fetchImpl = mock(async () =>
      Response.json({}),
    ) as unknown as typeof fetch;

    await expect(
      inspectElevenLabsSpeechEngine({
        apiKey: "example-api-key",
        speechEngineId: "  ",
        fetchImpl,
      }),
    ).rejects.toThrow("ElevenLabs Speech Engine ID is missing");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("returns only safe diagnostic fields", async () => {
    let requestedUrl = "";
    let requestedApiKey = "";
    const fetchImpl = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        requestedUrl = String(input);
        requestedApiKey = new Headers(init?.headers).get("xi-api-key") ?? "";
        return Response.json({
          speech_engine_id: "seng_example",
          speech_engine: {
            ws_url:
              "wss://voice.example.com/v1/live-voice/upstream?token=example-query-value",
            request_headers: {
              Authorization: "Bearer example-header-value",
            },
          },
          privacy: {
            record_voice: false,
            delete_audio: true,
            zero_retention_mode: true,
          },
        });
      },
    ) as unknown as typeof fetch;

    const diagnostic = await inspectElevenLabsSpeechEngine({
      apiKey: "example-api-key",
      speechEngineId: "seng_example",
      fetchImpl,
    });

    expect(requestedUrl).toBe(
      "https://api.elevenlabs.io/v1/speech-engine/seng_example",
    );
    expect(requestedApiKey).toBe("example-api-key");
    expect(diagnostic).toEqual({
      speechEngineId: "seng_example",
      upstreamUrl: "wss://voice.example.com/v1/live-voice/upstream",
      requestHeadersConfigured: true,
      recordVoice: false,
      deleteAudio: true,
      zeroRetentionMode: true,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("example-query-value");
    expect(JSON.stringify(diagnostic)).not.toContain("example-header-value");
    expect(JSON.stringify(diagnostic)).not.toContain("example-api-key");
  });

  test("rejects an HTTP upstream URL", async () => {
    const fetchImpl = mock(async () =>
      Response.json({
        speech_engine_id: "seng_example",
        speech_engine: { ws_url: "https://voice.example.com/upstream" },
      }),
    ) as unknown as typeof fetch;

    await expect(
      inspectElevenLabsSpeechEngine({
        apiKey: "example-api-key",
        speechEngineId: "seng_example",
        fetchImpl,
      }),
    ).rejects.toThrow(
      "ElevenLabs Speech Engine upstream must use a credential-free wss URL",
    );
  });

  test("does not include a provider response body in lookup failures", async () => {
    const fetchImpl = mock(
      async () =>
        new Response("example-provider-detail", {
          status: 403,
        }),
    ) as unknown as typeof fetch;

    const error = await inspectElevenLabsSpeechEngine({
      apiKey: "example-api-key",
      speechEngineId: "seng_example",
      fetchImpl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ElevenLabsSpeechEngineResourceError);
    expect(String(error)).toContain("lookup failed (403)");
    expect(String(error)).not.toContain("example-provider-detail");
  });
});
