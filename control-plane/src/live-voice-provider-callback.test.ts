import { describe, expect, test } from "bun:test";

import { assistantIdFromManagedVoiceRoutingToken } from "./live-voice-provider-callback.js";

function tokenFor(payload: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("managed voice callback routing token", () => {
  test("extracts an unexpired assistant routing hint", () => {
    expect(
      assistantIdFromManagedVoiceRoutingToken(
        tokenFor({
          version: 1,
          assistantId: "worklin-assistant-1",
          sessionId: "voice-session-1",
          expiresAtMs: 10_000,
        }),
        5_000,
      ),
    ).toBe("worklin-assistant-1");
  });

  test("rejects expired, malformed, and incomplete routing hints", () => {
    expect(
      assistantIdFromManagedVoiceRoutingToken(
        tokenFor({
          version: 1,
          assistantId: "worklin-assistant-1",
          sessionId: "voice-session-1",
          expiresAtMs: 5_000,
        }),
        5_000,
      ),
    ).toBeNull();
    expect(
      assistantIdFromManagedVoiceRoutingToken("not-a-token", 5_000),
    ).toBeNull();
    expect(
      assistantIdFromManagedVoiceRoutingToken(
        tokenFor({ version: 1, assistantId: "worklin-assistant-1" }),
        5_000,
      ),
    ).toBeNull();
  });
});
