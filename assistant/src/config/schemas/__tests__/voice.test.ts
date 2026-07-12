import { describe, expect, test } from "bun:test";

import { VoiceServiceSchema } from "../voice.js";

describe("VoiceServiceSchema", () => {
  test("defaults to the native compatibility engine with an empty pilot", () => {
    expect(VoiceServiceSchema.parse({})).toEqual({
      engine: "native",
      pilotAllowlist: [],
      providers: {
        hume: { configId: "", voiceId: "" },
        elevenlabs: { agentId: "", voiceId: "" },
      },
    });
  });

  test("accepts server-only managed provider configuration", () => {
    expect(
      VoiceServiceSchema.parse({
        engine: "hume",
        pilotAllowlist: ["actor-1"],
        providers: { hume: { configId: "config-1" } },
      }),
    ).toMatchObject({
      engine: "hume",
      pilotAllowlist: ["actor-1"],
      providers: { hume: { configId: "config-1" } },
    });
  });

  test("does not admit provider secrets into ordinary configuration", () => {
    const parsed = VoiceServiceSchema.parse({
      providers: {
        hume: { configId: "config-1", apiKey: "must-not-survive" },
        elevenlabs: { agentId: "agent-1", apiKey: "must-not-survive" },
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("must-not-survive");
    expect(parsed.providers.hume).not.toHaveProperty("apiKey");
    expect(parsed.providers.elevenlabs).not.toHaveProperty("apiKey");
  });
});
