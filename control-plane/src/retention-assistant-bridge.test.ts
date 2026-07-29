import { describe, expect, test } from "bun:test";

import {
  isRetentionAssistantOperatorRoute,
  parseRetentionAssistantOperatorRequest,
  retentionAssistantOperatorProxyRequest,
} from "./retention-assistant-bridge.js";

const base = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  userId: "auth0|user-1",
  assistantId: "assistant-1",
};

describe("retention assistant bridge contract", () => {
  test("accepts bounded preparation requests", async () => {
    expect(
      isRetentionAssistantOperatorRoute(
        "POST",
        "/v1/retention/reasoning/claim",
      ),
    ).toBe(true);
    const parsed = parseRetentionAssistantOperatorRequest(
      {
        ...base,
        method: "POST",
        path: "/v1/retention/segments",
        body: { name: "Likely second purchase" },
      },
      1024,
    );
    expect(parsed).not.toBeNull();
    const request = retentionAssistantOperatorProxyRequest(parsed!);
    expect(request.method).toBe("POST");
    expect(await request.json()).toEqual({
      name: "Likely second purchase",
    });
  });

  test("forbids privilege, integration, approval, and send routes", () => {
    for (const path of [
      "/v1/retention/access",
      "/v1/retention/integrations",
      "/v1/retention/campaigns/a/approve",
      "/v1/retention/campaigns/a/release",
    ]) {
      expect(isRetentionAssistantOperatorRoute("POST", path)).toBe(false);
    }
  });

  test("rejects query injection and oversized bodies", () => {
    expect(
      parseRetentionAssistantOperatorRequest(
        {
          ...base,
          method: "GET",
          path: "/v1/retention/status?organizationId=forged",
        },
        1024,
      ),
    ).toBeNull();
    expect(
      parseRetentionAssistantOperatorRequest(
        {
          ...base,
          method: "POST",
          path: "/v1/retention/segments",
          body: { value: "x".repeat(100) },
        },
        16,
      ),
    ).toBeNull();
  });
});
