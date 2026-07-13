import { executeBrandBrainRead } from "../../../../tools/retention/brand-brain-tools.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeBrandBrainRead(input, context);
}
