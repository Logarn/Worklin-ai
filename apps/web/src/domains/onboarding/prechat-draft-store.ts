/**
 * Account-scoped draft state for pre-chat onboarding.
 *
 * The draft is saved after every field or step change so a refresh, route
 * remount, or interrupted OAuth flow resumes with the same answers. Storage is
 * keyed by the authenticated user id and contains no credentials or tokens.
 */
import { create } from "zustand";

import {
  restoreNativeStep,
  type PreChatStepId,
} from "@/domains/onboarding/prechat-steps";
import { createSelectors } from "@/utils/create-selectors";

const DRAFT_VERSION = 1;
const DRAFT_STORAGE_PREFIX = "vellum:onboarding:prechatDraft:v1";
const PRECHAT_STEP_IDS: ReadonlySet<string> = new Set([
  "name",
  "brand",
  "taskTone",
  "tools",
  "priorAssistants",
  "google",
  "iosApp",
  "nativeName",
  "nativeVibe",
]);

interface PersistedPreChatDraft {
  version: typeof DRAFT_VERSION;
  currentStep: PreChatStepId;
  selectedTools: string[];
  selectedTasks: string[];
  selectedPriorAssistants: string[];
  brandName: string;
  websiteUrl: string;
  userName: string;
  selectedGroupId: string | null;
  selectedAvatarId: string;
  assistantName: string;
  googleConnected: boolean;
  googleScopes: string[];
}

export interface PreChatDraftDefaults {
  userName: string;
  selectedAvatarId: string;
  assistantName: string;
  isNative: boolean;
}

export interface PreChatDraftState {
  hydratedUserId: string | null;
  isHydrated: boolean;
  persistenceUserId: string | null;
  currentStep: PreChatStepId;
  selectedTools: Set<string>;
  selectedTasks: Set<string>;
  selectedPriorAssistants: Set<string>;
  brandName: string;
  websiteUrl: string;
  userName: string;
  selectedGroupId: string | null;
  selectedAvatarId: string;
  assistantName: string;
  googleConnected: boolean;
  googleScopes: string[];
}

export interface PreChatDraftActions {
  hydrateDraft: (args: {
    userId: string | null;
    defaults: PreChatDraftDefaults;
    persistenceEnabled: boolean;
  }) => void;
  setCurrentStep: (value: PreChatStepId) => void;
  setSelectedTools: (value: Set<string>) => void;
  setSelectedTasks: (value: Set<string>) => void;
  setSelectedPriorAssistants: (value: Set<string>) => void;
  setBrandName: (value: string) => void;
  setWebsiteUrl: (value: string) => void;
  setUserName: (value: string) => void;
  setSelectedGroupId: (value: string | null) => void;
  setSelectedAvatarId: (value: string) => void;
  setAssistantName: (value: string) => void;
  setGoogleConnection: (connected: boolean, scopes: string[]) => void;
  clearPersistedDraft: () => void;
}

export type PreChatDraftStore = PreChatDraftState & PreChatDraftActions;

function storageKey(userId: string): string {
  return `${DRAFT_STORAGE_PREFIX}:${encodeURIComponent(userId)}`;
}

function initialDraft(defaults: PreChatDraftDefaults): PreChatDraftState {
  return {
    hydratedUserId: null,
    isHydrated: false,
    persistenceUserId: null,
    currentStep: defaults.isNative ? "nativeName" : "name",
    selectedTools: new Set(),
    selectedTasks: new Set(),
    selectedPriorAssistants: new Set(),
    brandName: "",
    websiteUrl: "",
    userName: defaults.userName.trim(),
    selectedGroupId: null,
    selectedAvatarId: defaults.selectedAvatarId,
    assistantName: defaults.assistantName,
    googleConnected: false,
    googleScopes: [],
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPreChatStepId(value: unknown): value is PreChatStepId {
  return typeof value === "string" && PRECHAT_STEP_IDS.has(value);
}

function parseDraft(value: string | null): PersistedPreChatDraft | null {
  if (!value) return null;
  try {
    const candidate: unknown = JSON.parse(value);
    if (!candidate || typeof candidate !== "object") return null;
    const draft = candidate as Partial<PersistedPreChatDraft>;
    if (
      draft.version !== DRAFT_VERSION ||
      !isPreChatStepId(draft.currentStep) ||
      !isStringArray(draft.selectedTools) ||
      !isStringArray(draft.selectedTasks) ||
      !isStringArray(draft.selectedPriorAssistants) ||
      typeof draft.brandName !== "string" ||
      typeof draft.websiteUrl !== "string" ||
      typeof draft.userName !== "string" ||
      !(
        draft.selectedGroupId === null ||
        typeof draft.selectedGroupId === "string"
      ) ||
      typeof draft.selectedAvatarId !== "string" ||
      typeof draft.assistantName !== "string" ||
      typeof draft.googleConnected !== "boolean" ||
      !isStringArray(draft.googleScopes)
    ) {
      return null;
    }
    return draft as PersistedPreChatDraft;
  } catch {
    return null;
  }
}

function readDraft(userId: string): PersistedPreChatDraft | null {
  try {
    return parseDraft(localStorage.getItem(storageKey(userId)));
  } catch {
    return null;
  }
}

function persistedSnapshot(
  state: PreChatDraftState,
): PersistedPreChatDraft {
  return {
    version: DRAFT_VERSION,
    currentStep: state.currentStep,
    selectedTools: [...state.selectedTools],
    selectedTasks: [...state.selectedTasks],
    selectedPriorAssistants: [...state.selectedPriorAssistants],
    brandName: state.brandName,
    websiteUrl: state.websiteUrl,
    userName: state.userName,
    selectedGroupId: state.selectedGroupId,
    selectedAvatarId: state.selectedAvatarId,
    assistantName: state.assistantName,
    googleConnected: state.googleConnected,
    googleScopes: state.googleScopes,
  };
}

function writeDraft(userId: string, state: PreChatDraftState): void {
  try {
    localStorage.setItem(
      storageKey(userId),
      JSON.stringify(persistedSnapshot(state)),
    );
  } catch {
    // Browsers can deny localStorage in private or managed modes.
  }
}

function removeDraft(userId: string): void {
  try {
    localStorage.removeItem(storageKey(userId));
    sessionStorage.removeItem(`prechat_native_screen:${userId}`);
  } catch {
    // Storage can be unavailable in private or managed modes.
  }
}

export function clearPreChatDraftForUser(userId: string | null): void {
  if (userId) removeDraft(userId);
}

function restoreDraftState(
  persisted: PersistedPreChatDraft,
  defaults: PreChatDraftDefaults,
): PreChatDraftState {
  const validStepForPlatform = defaults.isNative
    ? persisted.currentStep === "nativeName" ||
      persisted.currentStep === "nativeVibe"
    : persisted.currentStep !== "nativeName" &&
      persisted.currentStep !== "nativeVibe";

  return {
    hydratedUserId: null,
    isHydrated: false,
    persistenceUserId: null,
    currentStep: validStepForPlatform
      ? persisted.currentStep
      : defaults.isNative
        ? "nativeName"
        : "name",
    selectedTools: new Set(persisted.selectedTools),
    selectedTasks: new Set(persisted.selectedTasks),
    selectedPriorAssistants: new Set(persisted.selectedPriorAssistants),
    brandName: persisted.brandName,
    websiteUrl: persisted.websiteUrl,
    userName: persisted.userName,
    selectedGroupId: persisted.selectedGroupId,
    selectedAvatarId: persisted.selectedAvatarId,
    assistantName: persisted.assistantName,
    googleConnected: persisted.googleConnected,
    googleScopes: [...persisted.googleScopes],
  };
}

const fallbackDefaults: PreChatDraftDefaults = {
  userName: "",
  selectedAvatarId: "",
  assistantName: "",
  isNative: false,
};

const usePreChatDraftStoreBase = create<PreChatDraftStore>()((set, get) => {
  const updateAndPersist = (patch: Partial<PreChatDraftState>): void => {
    const nextState = { ...get(), ...patch };
    set(patch);
    if (nextState.persistenceUserId) {
      writeDraft(nextState.persistenceUserId, nextState);
    }
  };

  return {
    ...initialDraft(fallbackDefaults),

    hydrateDraft: ({ userId, defaults, persistenceEnabled }) => {
      const persisted =
        persistenceEnabled && userId ? readDraft(userId) : null;
      const restored = persisted
        ? restoreDraftState(persisted, defaults)
        : initialDraft(defaults);

      if (!persisted && defaults.isNative && userId) {
        try {
          const legacyStep = restoreNativeStep(
            sessionStorage.getItem(`prechat_native_screen:${userId}`),
          );
          if (legacyStep) restored.currentStep = legacyStep;
        } catch {
          // The new draft still starts safely if legacy storage is unavailable.
        }
      }

      set({
        ...restored,
        hydratedUserId: userId,
        isHydrated: true,
        persistenceUserId:
          persistenceEnabled && userId ? userId : null,
      });
    },
    setCurrentStep: (value) => updateAndPersist({ currentStep: value }),
    setSelectedTools: (value) =>
      updateAndPersist({ selectedTools: new Set(value) }),
    setSelectedTasks: (value) =>
      updateAndPersist({ selectedTasks: new Set(value) }),
    setSelectedPriorAssistants: (value) =>
      updateAndPersist({ selectedPriorAssistants: new Set(value) }),
    setBrandName: (value) => updateAndPersist({ brandName: value }),
    setWebsiteUrl: (value) => updateAndPersist({ websiteUrl: value }),
    setUserName: (value) => updateAndPersist({ userName: value }),
    setSelectedGroupId: (value) =>
      updateAndPersist({ selectedGroupId: value }),
    setSelectedAvatarId: (value) =>
      updateAndPersist({ selectedAvatarId: value }),
    setAssistantName: (value) => updateAndPersist({ assistantName: value }),
    setGoogleConnection: (connected, scopes) =>
      updateAndPersist({
        googleConnected: connected,
        googleScopes: [...scopes],
      }),
    clearPersistedDraft: () => {
      clearPreChatDraftForUser(get().persistenceUserId);
    },
  };
});

export const usePreChatDraftStore = createSelectors(
  usePreChatDraftStoreBase,
);

export const preChatDraftTesting = {
  storageKey,
  reset: () => {
    usePreChatDraftStoreBase.setState({
      ...initialDraft(fallbackDefaults),
    });
  },
};
