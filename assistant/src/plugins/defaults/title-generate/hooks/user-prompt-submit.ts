/**
 * Default `user-prompt-submit` hook: kicks off conversation-title generation
 * from the submitted prompt.
 *
 * Title generation is a self-contained side effect that only needs the user's
 * prompt as context, so it belongs at the prompt-submit boundary rather than
 * threaded through the agent loop. The hook is a pure trigger — it schedules
 * the work and returns; persistence and the resulting
 * `conversation_title_updated` / `sync_changed` broadcast are owned by the
 * title service (see `memory/conversation-title-service.ts`).
 */

import type {
  PluginHookFn,
  UserPromptSubmitContext,
} from "@vellumai/plugin-api";

import { isPooledWorkerRuntime } from "../../../../config/env.js";
import { getConversation } from "../../../../memory/conversation-crud.js";
import {
  resolvePersistedTitleContext,
  type TitleContext,
} from "../../../../memory/conversation-title-context.js";
import { queueGenerateConversationTitle } from "../../../../memory/conversation-title-service.js";

const userPromptSubmit: PluginHookFn<UserPromptSubmitContext> = async (ctx) => {
  // Pooled workers cannot let a timer outlive the authenticated request and
  // tenant lease. Their first title pass runs synchronously at the successful
  // stop hook instead, after the main assistant reply has completed.
  if (isPooledWorkerRuntime()) return;

  let titleContext: TitleContext | undefined;

  // A remote human channel has no attached interactive UI, so
  // `isNonInteractive` alone cannot identify background work. Recover the
  // explicit persisted source/origin instead: Slack/user channel rows keep the
  // chat profile, while standard-row schedules keep the title profile.
  if (ctx.isNonInteractive) {
    try {
      const conversation = getConversation(ctx.conversationId);
      if (conversation && conversation.conversationType !== "standard") return;
      titleContext =
        resolvePersistedTitleContext(conversation) ??
        ({ origin: "misc" } as const);
    } catch {
      // The service re-reads persisted provenance before selecting a provider.
    }
  }

  // Deferred to a later macrotask so the main agent-loop LLM request is
  // issued first; on strict single-slot provider configs this keeps the
  // background title call from claiming the rate-limit slot ahead of the
  // user-visible response. The title service is itself fire-and-forget and
  // re-checks title replaceability before making any LLM call, so an
  // already-titled conversation incurs no generation.
  setTimeout(() => {
    queueGenerateConversationTitle({
      conversationId: ctx.conversationId,
      userMessage: ctx.prompt,
      ...(titleContext ? { context: titleContext } : {}),
    });
  }, 0);
};

export default userPromptSubmit;
