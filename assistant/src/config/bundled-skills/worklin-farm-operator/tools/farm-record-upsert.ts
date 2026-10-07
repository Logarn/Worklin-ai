import { executeFarmRecordUpsert } from "../../../../tools/farm/farm-record-tools.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeFarmRecordUpsert(input, context);
}
