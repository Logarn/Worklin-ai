/**
 * Authoritative process-local registry for live conversation agent loops.
 *
 * HTTP message submission intentionally returns before the agent loop settles,
 * so request accounting alone cannot prove a pooled worker is quiescent.
 * Every Conversation.runAgentLoop invocation is registered here until its
 * actual promise settles. The pooled-runtime drain probe aborts conversations
 * and then waits for this registry to reach zero before permitting reuse.
 */

const activeAgentLoops = new Set<Promise<void>>();

export async function trackConversationAgentLoop(
  run: Promise<void>,
): Promise<void> {
  activeAgentLoops.add(run);
  try {
    await run;
  } finally {
    activeAgentLoops.delete(run);
  }
}

export function activeConversationAgentLoopCount(): number {
  return activeAgentLoops.size;
}
