/**
 * Default `stop` hook: triggers the second-pass conversation-title
 * regeneration once a conversation has accumulated enough context.
 *
 * The first title is generated from the opening prompt alone (see
 * `./user-prompt-submit.ts`). After a few exchanges the conversation's real
 * topic is usually clearer, so a single second pass re-titles using the most
 * recent messages. This hook is the trigger — it fires the regeneration when
 * the conversation reaches its third user turn — and delegates the title
 * itself to the service (`memory/conversation-title-service.ts`), which
 * re-checks that the title is still auto-generated, resolves the title
 * provider, persists, and broadcasts the `conversation_title_updated` /
 * `sync_changed` events.
 *
 * Turn count is read from history rather than an external counter: the number
 * of genuine user prompts — user-role messages that aren't purely tool results
 * — is the conversation's turn number. Deriving it from history keeps the hook
 * stateless and means a mid-run array rewrite (compaction) can't invalidate it.
 */

import type { PluginHookFn, StopContext } from "@vellumai/plugin-api";

import { isPooledWorkerRuntime } from "../../../../config/env.js";
import { getConfig } from "../../../../config/loader.js";
import { getConversation } from "../../../../memory/conversation-crud.js";
import {
  resolvePersistedTitleContext,
  type TitleContext,
} from "../../../../memory/conversation-title-context.js";
import {
  generateConversationTitleRequestBound,
  queueRegenerateConversationTitle,
  regenerateConversationTitleRequestBound,
  type TitleTranscriptMessage,
} from "../../../../memory/conversation-title-service.js";
import type { Message } from "../../../../providers/types.js";

/**
 * User turn at which the second title pass fires. Matches the
 * `conversations.skipAutoRetitling` opt-out, documented as skipping the
 * regeneration "that fires after the third user turn".
 */
const SECOND_PASS_USER_TURN = 3;

/** A user-role message carrying only tool results, not a fresh prompt. */
function isToolResultMessage(message: Message): boolean {
  return (
    message.role === "user" &&
    message.content.length > 0 &&
    message.content.every(
      (block) =>
        block.type === "tool_result" || block.type === "web_search_tool_result",
    )
  );
}

/** Count of genuine user prompts in history — the conversation's turn number. */
function countUserTurns(messages: ReadonlyArray<Message>): number {
  let turns = 0;
  for (const message of messages) {
    if (message.role === "user" && !isToolResultMessage(message)) turns++;
  }
  return turns;
}

/** Human-readable text only; tool metadata and thinking stay out of titles. */
function extractTitleText(message: Message): string {
  const text: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      text.push(block.text);
    } else if (
      block.type === "tool_result" ||
      block.type === "web_search_tool_result"
    ) {
      if (typeof block.content === "string" && block.content) {
        text.push(block.content);
      }
      if ("contentBlocks" in block) {
        for (const nested of block.contentBlocks ?? []) {
          if (nested.type === "text") text.push(nested.text);
        }
      }
    }
  }
  return text.join("\n").trim();
}

function titleTranscript(
  messages: ReadonlyArray<Message>,
): TitleTranscriptMessage[] {
  const transcript: TitleTranscriptMessage[] = [];
  for (const message of messages) {
    const text = extractTitleText(message);
    if (!text) continue;
    transcript.push({ role: message.role, text });
  }
  return transcript;
}

function resolveStandardConversationTitleContext(conversationId: string): {
  isStandard: boolean;
  context?: TitleContext;
} {
  try {
    const conversation = getConversation(conversationId);
    if (conversation && conversation.conversationType !== "standard") {
      return { isStandard: false };
    }
    return {
      isStandard: true,
      context:
        resolvePersistedTitleContext(conversation) ??
        ({ origin: "misc" } as const),
    };
  } catch {
    // Preserve the existing fail-open behavior. The title service performs its
    // own provenance and replaceability checks before provider use/persistence.
    return { isStandard: true };
  }
}

const stop: PluginHookFn<StopContext> = async (ctx) => {
  // Re-title only at a genuine successful turn end (the model returned a reply
  // with no tool calls). Any other terminal — a provider rejection, abort, or
  // an output-limit cutoff — produced no new topic to re-title from.
  if (ctx.exitReason !== "no_tool_calls") return;

  const userTurnCount = countUserTurns(ctx.messages);
  const pooledRuntime = isPooledWorkerRuntime();

  if (pooledRuntime) {
    const isFirstPass = userTurnCount === 1;
    const isSecondPass = userTurnCount === SECOND_PASS_USER_TURN;
    if (!isFirstPass && !isSecondPass) return;
    if (isSecondPass && getConfig().conversations.skipAutoRetitling) return;
    const titleRoute = resolveStandardConversationTitleContext(
      ctx.conversationId,
    );
    if (!titleRoute.isStandard) return;

    // Keep pooled title work attached to the successful conversation POST.
    // The main response has already completed before this stop hook runs, and
    // awaiting here keeps the tenant lease active through title persistence.
    try {
      const transcript = titleTranscript(ctx.messages);
      if (isFirstPass) {
        const userMessage = transcript.find(
          (message) => message.role === "user",
        )?.text;
        const assistantResponse = [...transcript]
          .reverse()
          .find((message) => message.role === "assistant")?.text;
        if (!userMessage) return;
        await generateConversationTitleRequestBound({
          conversationId: ctx.conversationId,
          userMessage,
          assistantResponse,
          ...(titleRoute.context ? { context: titleRoute.context } : {}),
        });
        return;
      }

      await regenerateConversationTitleRequestBound({
        conversationId: ctx.conversationId,
        ...(titleRoute.context ? { context: titleRoute.context } : {}),
        recentMessages: transcript.slice(-3),
      });
    } catch (err) {
      ctx.logger.warn(
        {
          plugin: "title-generate",
          conversationId: ctx.conversationId,
          err,
        },
        "Request-bound conversation title generation failed (non-fatal)",
      );
    }
    return;
  }

  if (getConfig().conversations.skipAutoRetitling) return;

  if (userTurnCount !== SECOND_PASS_USER_TURN) return;

  // System conversations (background/scheduled) keep their deterministic
  // bootstrap title — multi-prompt background jobs can reach three user-role
  // turns with no human present, and a refined LLM title isn't worth the
  // tokens there. The lookup fails open: on a read error the hook behaves as
  // before (queues regeneration; the service re-checks isAutoTitle).
  const titleRoute = resolveStandardConversationTitleContext(
    ctx.conversationId,
  );
  if (!titleRoute.isStandard) return;

  const { conversationId } = ctx;
  // Deferred to a later macrotask so the just-completed turn's persistence
  // settles first. The service regenerates from the most recent stored
  // messages, so it must run after the reply is persisted to reflect it. The
  // service is itself fire-and-forget and re-checks replaceability, owning
  // provider resolution, persistence, and the resulting broadcast.
  setTimeout(() => {
    queueRegenerateConversationTitle({
      conversationId,
      ...(titleRoute.context ? { context: titleRoute.context } : {}),
    });
  }, 0);
};

export default stop;
