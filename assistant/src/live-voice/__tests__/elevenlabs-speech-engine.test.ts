import { createHash, createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { verifyElevenLabsSpeechEngineJwt } from "../elevenlabs-speech-engine.js";

function token(
  apiKey: string,
  overrides: Record<string, unknown> = {},
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://api.elevenlabs.io/convai/speech-engine",
      sub: "convai_speech_engine_upstream",
      iat: 1_000,
      exp: 1_100,
      ...overrides,
    }),
  ).toString("base64url");
  const secret = createHash("sha256").update(apiKey).digest();
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("ElevenLabs Speech Engine authorization", () => {
  test("accepts the documented issuer, subject, signature, and expiry", () => {
    expect(
      verifyElevenLabsSpeechEngineJwt(token("secret"), "secret", 1_000),
    ).toBe(true);
  });

  test("accepts the provider's optional bearer prefix and surrounding whitespace", () => {
    expect(
      verifyElevenLabsSpeechEngineJwt(
        `  Bearer ${token("secret")}  `,
        "  secret  ",
        1_000,
      ),
    ).toBe(true);
  });

  test("rejects a wrong secret, issuer, or expired token", () => {
    expect(
      verifyElevenLabsSpeechEngineJwt(token("secret"), "other", 1_000),
    ).toBe(false);
    expect(
      verifyElevenLabsSpeechEngineJwt(
        token("secret", { iss: "https://attacker.invalid" }),
        "secret",
        1_000,
      ),
    ).toBe(false);
    expect(
      verifyElevenLabsSpeechEngineJwt(token("secret"), "secret", 1_161),
    ).toBe(false);
    expect(
      verifyElevenLabsSpeechEngineJwt(
        token("secret", { iat: 1_061 }),
        "secret",
        1_000,
      ),
    ).toBe(false);
  });
});
