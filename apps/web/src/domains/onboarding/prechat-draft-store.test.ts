import { beforeEach, describe, expect, test } from "bun:test";

import {
  preChatDraftTesting,
  usePreChatDraftStore,
  type PreChatDraftDefaults,
} from "@/domains/onboarding/prechat-draft-store";

const defaults: PreChatDraftDefaults = {
  userName: "Alice",
  selectedAvatarId: "spiky_spark",
  assistantName: "Sunny",
  isNative: false,
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  preChatDraftTesting.reset();
});

describe("pre-chat onboarding draft", () => {
  test("restores the current step and every collected answer after reload", () => {
    const store = usePreChatDraftStore.getState();
    store.hydrateDraft({
      userId: "user-1",
      defaults,
      persistenceEnabled: true,
    });
    store.setUserName("Alicia");
    store.setAssistantName("Orbit");
    store.setSelectedAvatarId("orbit");
    store.setSelectedGroupId("bold");
    store.setBrandName("August Studio");
    store.setWebsiteUrl("https://example.com");
    store.setSelectedTasks(new Set(["email", "social"]));
    store.setSelectedTools(new Set(["gmail", "google-calendar"]));
    store.setSelectedPriorAssistants(new Set(["assistant-old"]));
    store.setGoogleConnection(true, ["gmail.readonly"]);
    store.setCurrentStep("google");

    preChatDraftTesting.reset();
    usePreChatDraftStore.getState().hydrateDraft({
      userId: "user-1",
      defaults,
      persistenceEnabled: true,
    });

    const restored = usePreChatDraftStore.getState();
    expect(restored.currentStep).toBe("google");
    expect(restored.userName).toBe("Alicia");
    expect(restored.assistantName).toBe("Orbit");
    expect(restored.selectedAvatarId).toBe("orbit");
    expect(restored.selectedGroupId).toBe("bold");
    expect(restored.brandName).toBe("August Studio");
    expect(restored.websiteUrl).toBe("https://example.com");
    expect([...restored.selectedTasks]).toEqual(["email", "social"]);
    expect([...restored.selectedTools]).toEqual([
      "gmail",
      "google-calendar",
    ]);
    expect([...restored.selectedPriorAssistants]).toEqual(["assistant-old"]);
    expect(restored.googleConnected).toBe(true);
    expect(restored.googleScopes).toEqual(["gmail.readonly"]);
  });

  test("does not expose one account's draft to another account", () => {
    usePreChatDraftStore.getState().hydrateDraft({
      userId: "user-1",
      defaults,
      persistenceEnabled: true,
    });
    usePreChatDraftStore.getState().setBrandName("Private Brand");
    usePreChatDraftStore.getState().setCurrentStep("tools");

    preChatDraftTesting.reset();
    usePreChatDraftStore.getState().hydrateDraft({
      userId: "user-2",
      defaults: { ...defaults, userName: "Bob" },
      persistenceEnabled: true,
    });

    const secondUser = usePreChatDraftStore.getState();
    expect(secondUser.currentStep).toBe("name");
    expect(secondUser.brandName).toBe("");
    expect(secondUser.userName).toBe("Bob");
  });

  test("clears the saved draft only when onboarding completes", () => {
    usePreChatDraftStore.getState().hydrateDraft({
      userId: "user-1",
      defaults,
      persistenceEnabled: true,
    });
    usePreChatDraftStore.getState().setCurrentStep("brand");

    const key = preChatDraftTesting.storageKey("user-1");
    expect(localStorage.getItem(key)).not.toBeNull();

    usePreChatDraftStore.getState().clearPersistedDraft();
    expect(localStorage.getItem(key)).toBeNull();
  });

  test("ignores corrupt saved data and starts safely from the beginning", () => {
    localStorage.setItem(
      preChatDraftTesting.storageKey("user-1"),
      '{"version":1,"currentStep":"not-a-step"}',
    );

    usePreChatDraftStore.getState().hydrateDraft({
      userId: "user-1",
      defaults,
      persistenceEnabled: true,
    });

    const restored = usePreChatDraftStore.getState();
    expect(restored.currentStep).toBe("name");
    expect(restored.userName).toBe("Alice");
  });

  test("keeps previews isolated from a real user's saved draft", () => {
    localStorage.setItem(
      preChatDraftTesting.storageKey("user-1"),
      JSON.stringify({
        version: 1,
        currentStep: "tools",
        selectedTools: ["gmail"],
        selectedTasks: [],
        selectedPriorAssistants: [],
        brandName: "Saved Brand",
        websiteUrl: "",
        userName: "Alice",
        selectedGroupId: null,
        selectedAvatarId: "spiky_spark",
        assistantName: "Sunny",
        googleConnected: false,
        googleScopes: [],
      }),
    );

    usePreChatDraftStore.getState().hydrateDraft({
      userId: "user-1",
      defaults,
      persistenceEnabled: false,
    });

    const preview = usePreChatDraftStore.getState();
    expect(preview.currentStep).toBe("name");
    expect(preview.brandName).toBe("");
  });
});
