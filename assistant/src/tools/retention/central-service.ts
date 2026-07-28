import { ipcCall } from "../../ipc/gateway-client.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

type RetentionOperatorResponse = {
  status: number;
  body: unknown;
};

export async function executeRetentionPlatformStatus(
  _input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return retentionOperatorRequest(context, "GET", "/v1/retention/status");
}

export async function executeRetentionCreateSegmentDefinition(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return retentionOperatorRequest(
    context,
    "POST",
    "/v1/retention/segments",
    requiredPayload(input),
  );
}

export async function executeRetentionClaimRecipientReasoning(
  _input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return retentionOperatorRequest(
    context,
    "POST",
    "/v1/retention/reasoning/claim",
    {},
  );
}

export async function executeRetentionRecordRecipientDecision(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return retentionOperatorRequest(
    context,
    "POST",
    "/v1/retention/decisions/complete",
    requiredPayload(input),
  );
}

export async function executeRetentionCreateCentralCampaign(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return retentionOperatorRequest(
    context,
    "POST",
    "/v1/retention/campaigns",
    requiredPayload(input),
  );
}

export async function executeRetentionFreezeCampaignAudience(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return retentionCampaignRequest(input, context, "audience/freeze");
}

export async function executeRetentionPrepareCampaignGeneration(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return retentionCampaignRequest(input, context, "generation/prepare");
}

export async function executeRetentionRecordCampaignMessage(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return retentionCampaignRequest(input, context, "messages");
}

export async function executeRetentionCampaignApprovalPreview(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const campaignId = requiredCampaignId(input);
  if (!campaignId) return invalidInput("campaign_id is required.");
  return retentionOperatorRequest(
    context,
    "GET",
    `/v1/retention/campaigns/${campaignId}/approval-preview`,
  );
}

async function retentionCampaignRequest(
  input: Record<string, unknown>,
  context: ToolContext,
  suffix: "audience/freeze" | "generation/prepare" | "messages",
): Promise<ToolExecutionResult> {
  const campaignId = requiredCampaignId(input);
  if (!campaignId) return invalidInput("campaign_id is required.");
  return retentionOperatorRequest(
    context,
    "POST",
    `/v1/retention/campaigns/${campaignId}/${suffix}`,
    requiredPayload(input),
  );
}

async function retentionOperatorRequest(
  context: ToolContext,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<ToolExecutionResult> {
  if (
    !context.platformOrganizationId ||
    !context.platformUserId ||
    !context.platformAssistantId
  ) {
    return errorResult(
      "platform_context_required",
      "This retention action requires an authenticated Worklin workspace.",
    );
  }
  const result = await ipcCall(
    "retention_operator_request",
    {
      organizationId: context.platformOrganizationId,
      userId: context.platformUserId,
      assistantId: context.platformAssistantId,
      method,
      path,
      ...(method === "POST" ? { body: body ?? {} } : {}),
    },
    30_000,
  );
  if (!isOperatorResponse(result)) {
    return errorResult(
      "retention_service_unavailable",
      "Worklin customer intelligence is temporarily unavailable.",
    );
  }
  return {
    content: JSON.stringify(result.body),
    isError: result.status < 200 || result.status >= 300,
  };
}

function requiredPayload(input: Record<string, unknown>): unknown {
  return input.payload && typeof input.payload === "object"
    ? input.payload
    : {};
}

function requiredCampaignId(input: Record<string, unknown>): string | null {
  const value = input.campaign_id;
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(value)
    ? value
    : null;
}

function isOperatorResponse(
  value: unknown,
): value is RetentionOperatorResponse {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { status?: unknown }).status === "number" &&
    Object.prototype.hasOwnProperty.call(value, "body")
  );
}

function invalidInput(message: string): ToolExecutionResult {
  return errorResult("invalid_retention_tool_input", message);
}

function errorResult(code: string, message: string): ToolExecutionResult {
  return {
    content: JSON.stringify({ error: { code, message } }),
    isError: true,
  };
}
