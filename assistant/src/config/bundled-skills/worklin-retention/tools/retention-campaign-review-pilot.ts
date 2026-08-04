import { executeRetentionCampaignReviewPilot } from "../../../../tools/retention/campaign-review-pilot.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeRetentionCampaignReviewPilot(input, context);
}
