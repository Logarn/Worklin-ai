/**
 * Zustand store for GitHub + Slack nudge preferences.
 *
 * Owns whether each nudge has been actioned (starred, joined) or
 * dismissed (banner) and when. `use-github-nudge.ts` and
 * `use-slack-nudge.ts` expose thin selector hooks backed by this store.
 *
 * **Storage model:**
 *
 * - The persist middleware serialises the whole nudge slice into a
 *   single localStorage key, `vellum:nudge-prefs`.
 * - Cross-tab updates: the persist middleware doesn't sync across tabs
 *   on its own. We listen for `storage` events on `vellum:nudge-prefs`
 *   and call `persist.rehydrate()` to pull in the other tab's write.
 *
 * Reference:
 * - {@link https://zustand.docs.pmnd.rs/}
 * - {@link https://zustand.docs.pmnd.rs/integrations/persisting-store-data}
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { createSelectors } from "@/utils/create-selectors";

// ---------------------------------------------------------------------------
// State + Actions
// ---------------------------------------------------------------------------

export interface NudgeState {
  githubStarred: boolean;
  githubBannerDismissed: boolean;
  /** Epoch ms of the most recent GitHub banner dismiss. 0 = never. */
  githubBannerDismissedAt: number;
  /** Epoch ms of the first time the GitHub nudge module observed the user. 0 = not yet recorded. */
  githubFirstSeenAt: number;
  /** Cumulative count of user messages sent across all conversations. */
  githubUserMessagesSeen: number;
  slackJoined: boolean;
  slackBannerDismissed: boolean;
  /** Epoch ms of the first time the Slack nudge module observed the user. 0 = not yet recorded. */
  slackFirstSeenAt: number;
}

export interface NudgeActions {
  markGitHubStarred: () => void;
  dismissGitHubBanner: () => void;
  /** Stamp `githubFirstSeenAt` to `Date.now()` on first observation. No-op afterwards. */
  ensureGitHubFirstSeenAt: () => void;
  incrementGitHubUserMessagesSeen: (delta: number) => void;
  markSlackJoined: () => void;
  dismissSlackBanner: () => void;
  /** Stamp `slackFirstSeenAt` to `Date.now()` on first observation. No-op afterwards. */
  ensureSlackFirstSeenAt: () => void;
}

export type NudgeStore = NudgeState & NudgeActions;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE: NudgeState = {
  githubStarred: false,
  githubBannerDismissed: false,
  githubBannerDismissedAt: 0,
  githubFirstSeenAt: 0,
  githubUserMessagesSeen: 0,
  slackJoined: false,
  slackBannerDismissed: false,
  slackFirstSeenAt: 0,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const NUDGE_STORE_KEY = "vellum:nudge-prefs";

const useNudgeStoreBase = create<NudgeStore>()(
  persist(
    (set, get) => ({
      ...INITIAL_STATE,

      markGitHubStarred: () => set({ githubStarred: true }),
      dismissGitHubBanner: () =>
        set({
          githubBannerDismissed: true,
          githubBannerDismissedAt: Date.now(),
        }),
      ensureGitHubFirstSeenAt: () => {
        if (get().githubFirstSeenAt === 0) {
          set({ githubFirstSeenAt: Date.now() });
        }
      },
      incrementGitHubUserMessagesSeen: (delta: number) => {
        if (delta <= 0) return;
        set({ githubUserMessagesSeen: get().githubUserMessagesSeen + delta });
      },
      markSlackJoined: () => set({ slackJoined: true }),
      dismissSlackBanner: () => set({ slackBannerDismissed: true }),
      ensureSlackFirstSeenAt: () => {
        if (get().slackFirstSeenAt === 0) {
          set({ slackFirstSeenAt: Date.now() });
        }
      },
    }),
    {
      name: NUDGE_STORE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        githubStarred: state.githubStarred,
        githubBannerDismissed: state.githubBannerDismissed,
        githubBannerDismissedAt: state.githubBannerDismissedAt,
        githubFirstSeenAt: state.githubFirstSeenAt,
        githubUserMessagesSeen: state.githubUserMessagesSeen,
        slackJoined: state.slackJoined,
        slackBannerDismissed: state.slackBannerDismissed,
        slackFirstSeenAt: state.slackFirstSeenAt,
      }),
    },
  ),
);

export const useNudgeStore = createSelectors(useNudgeStoreBase);

// ---------------------------------------------------------------------------
// Cross-tab sync
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === NUDGE_STORE_KEY) {
      void useNudgeStoreBase.persist.rehydrate();
    }
  });
}

