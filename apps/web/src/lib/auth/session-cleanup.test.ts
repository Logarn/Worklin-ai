import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useComposerStore } from "@/domains/chat/composer-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useTurnStore } from "@/domains/chat/turn-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { clearUserScopedStorage, clearUserScopedFrontendState } from "./session-cleanup";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();

  useConversationStore.getState().reset();
  useResolvedAssistantsStore.getState().clear();
  useChatSessionStore.getState().reset();
  useInteractionStore.getState().resetAll();
  useTurnStore.getState().resetTurn();
  useComposerStore.getState().reset();
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("clearUserScopedFrontendState", () => {
  test("resets every user-scoped frontend store", () => {
    const conversation = useConversationStore.getState();
    conversation.setActiveConversationId("conversation-1");
    conversation.setEditingConversationId("conversation-2");
    conversation.markConversationProcessing("conversation-1", 42);
    conversation.addAttentionConversationId("conversation-2");
    conversation.setPendingDraftProfile("conversation-3", "profile");

    useResolvedAssistantsStore.getState().upsertFromApi({
      id: "asst-1",
      name: "Assistant",
      created: "2026-01-01T00:00:00Z",
      is_local: true,
    } as Parameters<
      ReturnType<typeof useResolvedAssistantsStore.getState>["upsertFromApi"]
    >[0]);
    useResolvedAssistantsStore.getState().setSelectedAssistant("asst-1");
    useResolvedAssistantsStore.getState().setActiveAssistantId("asst-1");

    const chatSession = useChatSessionStore.getState();
    chatSession.setMessages([
      { id: "1", role: "assistant" } as never,
    ]);
    chatSession.setError({ type: "error", message: "x", scope: "chat" } as never);
    chatSession.setTranscriptPagination({
      hasMore: false,
      oldestTimestamp: null,
      isLoadingOlder: false,
      isPinnedToLatest: true,
    });
    chatSession.setContextWindowUsage({
      tokens: 1000,
      maxTokens: 5000,
      fillRatio: 0.8,
    } as never);
    chatSession.setCompactionCircuitOpenUntil(new Date("2026-01-01T00:00:00Z"));
    chatSession.addDismissedSurfaceId("dismissed-surface");
    chatSession.batchUpdateStreamingMessageIds(["streaming-message"], []);
    chatSession.pushPendingQueuedMessageId("queued-1");
    chatSession.setRequestIdMapping("req-1", "message-1");
    chatSession.addPendingLocalDeletion("message-2");
    chatSession.setExpandedToolCallId("tool-call-1", true);
    chatSession.setExpandedCardId("card-1", true);
    chatSession.setContextWindowUsageForConversation("conversation-1", {
      tokens: 500,
      maxTokens: 1000,
      fillRatio: 0.5,
    } as never);
    chatSession.switchToConversation({
      assistantId: "asst-1",
      activeConversationId: "conversation-1",
    });
    chatSession.markDraftResolution();
    chatSession.setLastAppliedDataTimestamp(1234);

    const interaction = useInteractionStore.getState();
    interaction.showSecret({ requestId: "s1" } as never);
    interaction.submitSecretStart();
    interaction.submitSecretEnd(true);
    interaction.showConfirmation({ requestId: "c1" } as never);
    interaction.submitConfirmationStart();
    interaction.showContactRequest({ requestId: "co1" } as never);
    interaction.submitContactRequestStart();
    interaction.acceptContactRequest();
    interaction.showQuestion({ requestId: "q1", entries: [] } as never);
    interaction.submitQuestionStart();
    interaction.dismissQuestionCard();
    interaction.setInlineConfirmationToolCallId("tool-1");
    interaction.addUnknownNudgeToolCallId("tool-x");

    useTurnStore.getState().requestSend("turn-1");
    useTurnStore.getState().onTextDelta();

    const composer = useComposerStore.getState();
    composer.loadAssistantDrafts("assistant-1");
    composer.saveDraft("conversation-2", "replied draft");
    composer.setInput("typed message");
    composer.handleConversationSwitch({
      previousKey: "conversation-1",
      nextKey: "conversation-2",
    });

    clearUserScopedFrontendState();

    expect(useConversationStore.getState().activeConversationId).toBeNull();
    expect(useConversationStore.getState().editingConversationId).toBeNull();
    expect(useConversationStore.getState().processingConversationIds.size).toBe(0);
    expect(useResolvedAssistantsStore.getState().assistants).toEqual([]);
    expect(useResolvedAssistantsStore.getState().selectedAssistantId).toBeNull();
    expect(useResolvedAssistantsStore.getState().activeAssistantId).toBeNull();
    expect(useResolvedAssistantsStore.getState().assistantsHydrated).toBe(false);
    expect(useChatSessionStore.getState().messages).toEqual([]);
    expect(useChatSessionStore.getState().error).toBeNull();
    expect(useInteractionStore.getState().pendingSecret).toBeNull();
    expect(useInteractionStore.getState().isSubmittingSecret).toBe(false);
    expect(useInteractionStore.getState().pendingConfirmation).toBeNull();
    expect(useComposerStore.getState().input).toBe("");
    expect(useComposerStore.getState().restoredDraftConversationId).toBeNull();
    expect(useComposerStore.getState().attachments).toEqual([]);
    expect(useComposerStore.getState().attachmentLastError).toBeNull();
    expect(useTurnStore.getState().phase).toBe("idle");
    expect(useTurnStore.getState().activeTurnId).toBeNull();
  });
});

describe("clearUserScopedStorage", () => {
  test("clears sessionStorage entirely", () => {
    const keys = [
      "vellum:edit-chat:asst-1:app-1",
      "arbitrary-session-key",
    ];
    for (const key of keys) {
      sessionStorage.setItem(key, "value");
    }

    clearUserScopedStorage();

    for (const key of keys) {
      expect(sessionStorage.getItem(key)).toBeNull();
    }
  });

  test("removes all vellum: prefixed keys from localStorage", () => {
    const keys = [
      "vellum:pinnedApps",
      "vellum:lastViewedConversation:asst-1",
      "vellum:sidebar-open-categories:asst-1",
      "vellum:sidebar-open-custom-groups:asst-1",
      "vellum:selectedAssistantId",
      "vellum:nudge-prefs",
      "vellum:chatDrafts:asst-1",
      "vellum:ctxwindow:asst-1",
      "vellum:dismissed-surfaces:asst-1",
      "vellum:ff:some-flag",
      "vellum:onboarding:tosAccepted",
      "vellum:onboarding:aiDataConsent",
      "vellum:onboarding:completed",
      "vellum:onboarding:selectedVersion",
      "vellum:integrations:bannerDismissed",
      "vellum:voice:activationKey",
      "vellum:voice:ttsApiKey:openai",
      "vellum:voice:sttApiKey:openai",
      "vellum:gw:token",
      "vellum:local:lockfile",
      "vellum:ai:imageGenMode",
      "vellum:debug:impersonateAssistantVersion",
      "vellum:sidebar:collapsed",
      "vellum:sidebar:width",
      "vellum:diskPressureDismissed:asst-1",
      "vellum:skills:tipDismissed",
    ];
    for (const key of keys) {
      localStorage.setItem(key, "value");
    }

    clearUserScopedStorage();

    for (const key of keys) {
      expect(localStorage.getItem(key)).toBeNull();
    }
  });

  test("preserves device: prefixed keys", () => {
    localStorage.setItem("device:theme", "dark");
    localStorage.setItem("device:share_analytics", "true");
    localStorage.setItem("device:share_diagnostics", "false");
    localStorage.setItem("device:biometric_enabled", "false");
    localStorage.setItem("device:llm_log_retention", "dontRetain");
    localStorage.setItem("device:timezone", "America/New_York");
    localStorage.setItem("device:media_embeds_enabled", "false");
    localStorage.setItem("device:media_embed_domains", '["youtube.com"]');
    localStorage.setItem("device:last_user_id", "user-123");

    clearUserScopedStorage();

    expect(localStorage.getItem("device:theme")).toBe("dark");
    expect(localStorage.getItem("device:share_analytics")).toBe("true");
    expect(localStorage.getItem("device:share_diagnostics")).toBe("false");
    expect(localStorage.getItem("device:biometric_enabled")).toBe("false");
    expect(localStorage.getItem("device:llm_log_retention")).toBe("dontRetain");
    expect(localStorage.getItem("device:timezone")).toBe("America/New_York");
    expect(localStorage.getItem("device:media_embeds_enabled")).toBe("false");
    expect(localStorage.getItem("device:media_embed_domains")).toBe('["youtube.com"]');
    expect(localStorage.getItem("device:last_user_id")).toBe("user-123");
  });

  test("automatically clears future vellum: keys without needing explicit registration", () => {
    const keys = ["vellum:some-future-feature:asst-1", "vellum:another-feature"];
    for (const key of keys) {
      localStorage.setItem(key, "value");
    }

    clearUserScopedStorage();

    for (const key of keys) {
      expect(localStorage.getItem(key)).toBeNull();
    }
  });

  test("future device: keys are automatically preserved", () => {
    localStorage.setItem("device:some_new_setting", "value");
    localStorage.setItem("device:another_setting", "data");

    clearUserScopedStorage();

    expect(localStorage.getItem("device:some_new_setting")).toBe("value");
    expect(localStorage.getItem("device:another_setting")).toBe("data");
  });

  test("leaves third-party keys untouched", () => {
    localStorage.setItem("_ga", "GA1.2.123456");
    localStorage.setItem("intercom-session", "abc");
    localStorage.setItem("some-other-sdk", "data");

    clearUserScopedStorage();

    expect(localStorage.getItem("_ga")).toBe("GA1.2.123456");
    expect(localStorage.getItem("intercom-session")).toBe("abc");
    expect(localStorage.getItem("some-other-sdk")).toBe("data");
  });

  test("removes vellum: keys while preserving device: and third-party keys", () => {
    localStorage.setItem("device:theme", "dark");
    localStorage.setItem("device:share_analytics", "true");
    localStorage.setItem("vellum:pinnedApps", "[]");
    localStorage.setItem("vellum:ff:my-flag", "true");
    localStorage.setItem("vellum:onboarding:completed", "true");
    localStorage.setItem("_ga", "GA1.2.123456");

    clearUserScopedStorage();

    expect(localStorage.getItem("device:theme")).toBe("dark");
    expect(localStorage.getItem("device:share_analytics")).toBe("true");
    expect(localStorage.getItem("_ga")).toBe("GA1.2.123456");
    expect(localStorage.getItem("vellum:pinnedApps")).toBeNull();
    expect(localStorage.getItem("vellum:ff:my-flag")).toBeNull();
    expect(localStorage.getItem("vellum:onboarding:completed")).toBeNull();
  });

  test("preserves active app. nudge keys on logout", () => {
    localStorage.setItem("app.iosNudge.downloaded", "true");
    localStorage.setItem("app.macOsNudge.bannerDismissed", "true");
    localStorage.setItem("app.githubNudge.starred", "true");

    clearUserScopedStorage();

    // Active iOS/macOS nudge keys must survive logout — they are
    // still read by use-ios-app-nudge.ts and use-macos-app-nudge.ts.
    // Dead github/discord keys are removed at startup by removeKey()
    // in storage-migration.ts, not by the logout sweep.
    expect(localStorage.getItem("app.iosNudge.downloaded")).toBe("true");
    expect(localStorage.getItem("app.macOsNudge.bannerDismissed")).toBe("true");
    expect(localStorage.getItem("app.githubNudge.starred")).toBe("true");
  });

  test("clears legacy prefixed keys if startup migration failed", () => {
    // eslint-disable-next-line no-restricted-syntax
    localStorage.setItem("gw:token", "legacy-jwt-token");
    // generic-examples:ignore-next-line
    localStorage.setItem("gw:expiresAt", "9999999999");
    localStorage.setItem("voice:ttsProvider", "elevenlabs");
    localStorage.setItem("onboarding.completed", "true");
    localStorage.setItem("ff:client:darkMode", "true");
    localStorage.setItem("local:lockfile", "{}");
    localStorage.setItem("integrations.bannerDismissed", "true");
    localStorage.setItem("vellumDebug.flags.impersonateAssistantVersion", "0.8.6");
    localStorage.setItem("vellum_image_gen_mode", "enabled");

    clearUserScopedStorage();

    expect(localStorage.getItem("gw:token")).toBeNull();
    expect(localStorage.getItem("gw:expiresAt")).toBeNull();
    expect(localStorage.getItem("voice:ttsProvider")).toBeNull();
    expect(localStorage.getItem("onboarding.completed")).toBeNull();
    expect(localStorage.getItem("ff:client:darkMode")).toBeNull();
    expect(localStorage.getItem("local:lockfile")).toBeNull();
    expect(localStorage.getItem("integrations.bannerDismissed")).toBeNull();
    expect(localStorage.getItem("vellumDebug.flags.impersonateAssistantVersion")).toBeNull();
    expect(localStorage.getItem("vellum_image_gen_mode")).toBeNull();
  });

  test("preserves legacy device-level keys from cleanup", () => {
    localStorage.setItem("vellum_theme", "dark");
    localStorage.setItem("vellum_share_analytics", "true");
    localStorage.setItem("vellum_share_diagnostics", "false");
    localStorage.setItem("vellum_biometric_enabled", "false");
    localStorage.setItem("vellum_llm_log_retention", "dontRetain");
    localStorage.setItem("vellum_timezone", "America/New_York");
    localStorage.setItem("vellum_media_embeds_enabled", "false");
    localStorage.setItem("vellum_media_embed_domains", '["youtube.com"]');
    localStorage.setItem("onboarding.lastUserId", "user-123");

    clearUserScopedStorage();

    expect(localStorage.getItem("vellum_theme")).toBe("dark");
    expect(localStorage.getItem("vellum_share_analytics")).toBe("true");
    expect(localStorage.getItem("vellum_share_diagnostics")).toBe("false");
    expect(localStorage.getItem("vellum_biometric_enabled")).toBe("false");
    expect(localStorage.getItem("vellum_llm_log_retention")).toBe("dontRetain");
    expect(localStorage.getItem("vellum_timezone")).toBe("America/New_York");
    expect(localStorage.getItem("vellum_media_embeds_enabled")).toBe("false");
    expect(localStorage.getItem("vellum_media_embed_domains")).toBe('["youtube.com"]');
    expect(localStorage.getItem("onboarding.lastUserId")).toBe("user-123");
  });
});
