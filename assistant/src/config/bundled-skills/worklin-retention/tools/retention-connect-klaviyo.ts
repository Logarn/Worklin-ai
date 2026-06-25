import { executeRetentionConnectKlaviyo } from "../../../../tools/retention/worklin-retention.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeRetentionConnectKlaviyo(input, context);
}
