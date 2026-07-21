/**
 * Minimal tool manifest for pooled workers.
 *
 * Keep this module dependency-small: importing the dedicated manifest also
 * evaluates credential, workflow, retention, external-skill, and managed
 * provider modules before a tenant assignment exists.
 */

import { askQuestionTool } from "./ask-question/ask-question-tool.js";
import { fileEditTool } from "./filesystem/edit.js";
import { fileListTool } from "./filesystem/list.js";
import { fileReadTool } from "./filesystem/read.js";
import { fileWriteTool } from "./filesystem/write.js";
import { recallTool, rememberTool } from "./memory/register.js";
import { webFetchTool } from "./network/web-fetch.js";
import type { ToolDefinition } from "./types.js";

export const pooledExplicitTools: ToolDefinition[] = [
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  fileListTool,
  webFetchTool,
  rememberTool,
  recallTool,
  askQuestionTool,
];
