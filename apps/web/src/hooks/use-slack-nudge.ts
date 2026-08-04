/**
 * Slack-community nudge public API.
 *
 * Backed by `useNudgeStore`; this file exposes the Slack-specific derived
 * state, click handlers, and prerequisite checks (account age, GitHub-nudge
 * cascade, conversation count).
 */

import { useCallback } from "react";

import {
  readGitHubBannerDismissedAt,
  readGitHubNudgeStarred,
} from "@/hooks/use-github-nudge";
import { useNudgeStore } from "@/stores/nudge-store";
import { WORKLIN_SLACK_INVITE_URL } from "@/utils/external-urls";

export const SLACK_MIN_CONVERSATION_COUNT = 2;
export const SLACK_MIN_ACCOUNT_AGE_MS = 0;
export const SLACK_GITHUB_DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function ensureSlackFirstSeenAt(): void {
  useNudgeStore.getState().ensureSlackFirstSeenAt();
}

export function readSlackFirstSeenAt(): number {
  return useNudgeStore.getState().slackFirstSeenAt;
}

function isGitHubNudgeResolved(): boolean {
  if (readGitHubNudgeStarred()) {
    return true;
  }
  return useNudgeStore.getState().githubBannerDismissed;
}

function isGitHubDismissCooldownElapsed(): boolean {
  const dismissedAt = readGitHubBannerDismissedAt();
  if (dismissedAt === 0) {
    return true;
  }
  return Date.now() - dismissedAt >= SLACK_GITHUB_DISMISS_COOLDOWN_MS;
}

function isAccountAgeEligible(): boolean {
  if (SLACK_MIN_ACCOUNT_AGE_MS <= 0) {
    return true;
  }
  const firstSeen = readSlackFirstSeenAt();
  if (firstSeen === 0) {
    return false;
  }
  return Date.now() - firstSeen >= SLACK_MIN_ACCOUNT_AGE_MS;
}

export function areSlackPrerequisitesMet(
  platformNudgeResolved: boolean,
  conversationCount: number,
): boolean {
  if (!platformNudgeResolved) return false;
  if (!isGitHubNudgeResolved()) return false;
  if (!isAccountAgeEligible()) return false;
  if (conversationCount < SLACK_MIN_CONVERSATION_COUNT) return false;
  if (!isGitHubDismissCooldownElapsed()) return false;
  return true;
}

export function readSlackNudgeJoined(): boolean {
  return useNudgeStore.getState().slackJoined;
}

export function joinSlack(): void {
  openSlackInvite();
  useNudgeStore.getState().markSlackJoined();
}

export interface SlackNudgeState {
  bannerShouldShow: boolean;
  handleJoin: () => void;
  handleBannerDismiss: () => void;
}

export function useSlackNudgeState(
  platformNudgeResolved: boolean,
  conversationCount: number,
): SlackNudgeState {
  const joined = useNudgeStore.use.slackJoined();
  const bannerDismissed = useNudgeStore.use.slackBannerDismissed();

  useNudgeStore.use.githubStarred();
  useNudgeStore.use.githubBannerDismissed();
  useNudgeStore.use.slackFirstSeenAt();

  const prerequisitesMet = areSlackPrerequisitesMet(
    platformNudgeResolved,
    conversationCount,
  );

  const handleJoin = useCallback(() => {
    openSlackInvite();
    useNudgeStore.getState().markSlackJoined();
  }, []);

  const handleBannerDismiss = useCallback(() => {
    useNudgeStore.getState().dismissSlackBanner();
  }, []);

  return {
    bannerShouldShow: prerequisitesMet && !joined && !bannerDismissed,
    handleJoin,
    handleBannerDismiss,
  };
}

export function openSlackInvite(): void {
  if (typeof window === "undefined") return;
  window.open(WORKLIN_SLACK_INVITE_URL, "_blank", "noopener,noreferrer");
}
