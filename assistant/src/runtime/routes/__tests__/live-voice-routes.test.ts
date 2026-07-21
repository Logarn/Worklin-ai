import { describe, expect, test } from "bun:test";

import type { AuthContext } from "../../auth/types.js";
import { ROUTES } from "../live-voice-routes.js";

const bootstrapRoute = ROUTES.find(
  (route) => route.operationId === "live_voice_session_bootstrap",
);

function actorContext(): AuthContext {
  return {
    subject: "actor:self:actor-1",
    principalType: "actor",
    assistantId: "self",
    actorPrincipalId: "actor-1",
    scopeProfile: "actor_client_v1",
    scopes: new Set(["calls.write"]),
    policyEpoch: 1,
    tenantContext: {
      version: 1,
      organizationId: "org-1",
      userId: "user-1",
      assistantId: "assistant-1",
      actorId: "actor-1",
      requestId: "request-1",
    },
  };
}

describe("live voice tenant binding", () => {
  test("rejects bootstrap for an assistant outside the signed tenant", async () => {
    expect(bootstrapRoute).toBeDefined();
    await expect(
      bootstrapRoute!.handler({
        body: { assistantId: "assistant-2" },
        headers: {
          "x-vellum-actor-principal-id": "actor-1",
          "x-vellum-org-id": "org-1",
        },
        authContext: actorContext(),
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    });
  });
});
