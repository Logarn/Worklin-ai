import { afterEach, describe, expect, test } from "bun:test";

import {
  mockGatewayIpc,
  resetMockGatewayIpc,
} from "../../__tests__/mock-gateway-ipc.js";
import type { ToolContext } from "../types.js";
import {
  executeRetentionCampaignApprovalPreview,
  executeRetentionClaimRecipientReasoning,
  executeRetentionPlatformStatus,
} from "./central-service.js";

const context = {
  platformOrganizationId: "11111111-1111-4111-8111-111111111111",
  platformUserId: "auth0|user-1",
  platformAssistantId: "assistant-1",
} as ToolContext;

afterEach(resetMockGatewayIpc);

describe("central retention tools", () => {
  test("fail closed without verified tenant context", async () => {
    const result = await executeRetentionPlatformStatus({}, {} as ToolContext);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error.code).toBe(
      "platform_context_required",
    );
  });

  test("returns the gateway-authorized central service response", async () => {
    mockGatewayIpc(null, {
      results: {
        retention_operator_request: {
          status: 200,
          body: { organizationId: context.platformOrganizationId },
        },
      },
    });
    const result = await executeRetentionPlatformStatus({}, context);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      organizationId: context.platformOrganizationId,
    });
  });

  test("does not expose approval as a write action", async () => {
    mockGatewayIpc(null, {
      results: {
        retention_operator_request: {
          status: 200,
          body: { approvalStatus: "review_required" },
        },
      },
    });
    const result = await executeRetentionCampaignApprovalPreview(
      {
        campaign_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      context,
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content).approvalStatus).toBe("review_required");
  });

  test("returns only gateway-leased recipient reasoning work", async () => {
    mockGatewayIpc(null, {
      results: {
        retention_operator_request: {
          status: 200,
          body: {
            work: {
              jobId: "job-1",
              dossierSha256: "a".repeat(64),
            },
          },
        },
      },
    });
    const result = await executeRetentionClaimRecipientReasoning({}, context);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content).work.jobId).toBe("job-1");
  });
});
