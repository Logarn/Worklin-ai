import { executeRetentionRecordCampaignMessage } from "../../../../tools/retention/central-service.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeRetentionRecordCampaignMessage(input, context);
}
