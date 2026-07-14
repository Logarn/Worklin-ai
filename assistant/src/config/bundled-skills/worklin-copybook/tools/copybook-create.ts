import { executeCopybookCreate } from "../../../../tools/retention/copybook-tools.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return executeCopybookCreate(input, context);
}
