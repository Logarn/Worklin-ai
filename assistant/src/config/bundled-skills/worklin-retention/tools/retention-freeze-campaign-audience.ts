import { executeRetentionFreezeCampaignAudience } from "../../../../tools/retention/central-service.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeRetentionFreezeCampaignAudience(input, context);
}
