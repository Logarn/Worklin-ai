import type { QueryClient } from "@tanstack/react-query";

import {
  fetchAssistantCharacterProfile,
  fetchCharacterTraits,
  saveAssistantCharacterProfile,
  saveCharacterTraits,
} from "@/assistant/avatar-api";
import {
  WORKLIN_AVATAR_CHOICES,
  profileFromCharacter,
  type AssistantCharacter,
} from "@/components/avatar/assistant-character-packs";
import { captureError } from "@/lib/sentry/capture-error";
import { avatarQueryKey } from "@/lib/sync/query-tags";
import type { CharacterTraits } from "@/types/avatar";

/**
 * Persist the random hatch avatar (skipping the save when one already exists)
 * and invalidate the avatar query that feeds the Dock + menu-bar icons, the
 * favicon, and the in-app avatar. Fire-and-forget: callers do NOT await it, so
 * onboarding never blocks on the server-side render — it runs in the background
 * as the user lands in the app. The avatar query holds results with
 * `staleTime: Infinity` and is disabled until the assistant activates, so its
 * first fetch can beat the save and cache an avatar-less result; the post-save
 * invalidate forces a refetch that picks up the persisted traits, so the icons
 * self-correct within a beat rather than sticking on the bundled mark.
 *
 * Only call this for a freshly hatched assistant, never for an already-active
 * one: a returning user may have an uploaded/AI image avatar, which deletes the
 * character-traits sidecar, so a "no traits" read would wrongly seed random
 * traits over their image.
 *
 * Shared by the standalone hatching screen and the cast flow's background
 * hatch so a cast-hatched assistant lands with a seeded avatar too.
 */
export async function seedHatchAvatar(
  assistantId: string,
  traits: CharacterTraits,
  queryClient: QueryClient,
  preferredAvatar?: AssistantCharacter | null,
  preferredAssistantName?: string | null,
): Promise<void> {
  try {
    const [existingProfile, existingTraits] = await Promise.all([
      fetchAssistantCharacterProfile(assistantId),
      fetchCharacterTraits(assistantId),
    ]);
    if (!existingProfile && !existingTraits) {
      const defaultAvatar =
        preferredAvatar ??
        WORKLIN_AVATAR_CHOICES[
          Math.floor(Math.random() * WORKLIN_AVATAR_CHOICES.length)
        ];
      const preferredName = preferredAssistantName?.trim();
      const savedProfile = defaultAvatar
        ? await saveAssistantCharacterProfile(assistantId, {
            ...profileFromCharacter(defaultAvatar),
            assistantName:
              preferredName || defaultAvatar.shortName,
          })
        : false;
      if (!savedProfile) {
        await saveCharacterTraits(assistantId, traits);
      }
    }
    void queryClient.invalidateQueries({
      queryKey: avatarQueryKey(assistantId),
    });
  } catch (err) {
    captureError(err, { context: "onboarding_avatar_sync" });
  }
}
