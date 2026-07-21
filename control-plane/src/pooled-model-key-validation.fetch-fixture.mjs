import { appendFileSync } from "node:fs";

const realFetch = globalThis.fetch.bind(globalThis);
const validationRequests = new Map([
  [
    "https://api.anthropic.com/v1/models?limit=1",
    { provider: "anthropic", credentialHeader: "x-api-key" },
  ],
  [
    "https://api.fireworks.ai/inference/v1/models",
    { provider: "fireworks", credentialHeader: "authorization" },
  ],
  [
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
    { provider: "gemini", credentialHeader: "x-goog-api-key" },
  ],
  [
    "https://api.moonshot.ai/v1/models",
    { provider: "kimi", credentialHeader: "authorization" },
  ],
  [
    "https://api.minimax.io/v1/models",
    { provider: "minimax", credentialHeader: "authorization" },
  ],
  [
    "https://api.openai.com/v1/models",
    { provider: "openai", credentialHeader: "authorization" },
  ],
  [
    "https://openrouter.ai/api/v1/auth/key",
    { provider: "openrouter", credentialHeader: "authorization" },
  ],
]);

globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const validationRequest = validationRequests.get(url);
  if (!validationRequest) return realFetch(input, init);

  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const encodedCredential = headers.get(validationRequest.credentialHeader);
  const credential =
    validationRequest.credentialHeader === "authorization"
      ? encodedCredential?.replace(/^Bearer /u, "")
      : encodedCredential;
  const accepted =
    credential === `test-${validationRequest.provider}-key-tenant-pool` ||
    credential === `test-${validationRequest.provider}-rotation-key-tenant-pool`;
  const explicitlyRejected =
    credential === `test-invalid-${validationRequest.provider}-key-tenant-pool`;
  if (!accepted && !explicitlyRejected) {
    throw new Error(
      `Unexpected ${validationRequest.provider} validation credential.`,
    );
  }

  const auditPath = process.env.WORKLIN_TEST_PROVIDER_VALIDATION_AUDIT_PATH;
  if (auditPath) {
    appendFileSync(
      auditPath,
      `${JSON.stringify({
        url,
        credentialHeader: validationRequest.credentialHeader,
        outcome: accepted ? "accepted" : "rejected",
      })}\n`,
    );
  }
  return new Response("{}", { status: accepted ? 200 : 401 });
};
