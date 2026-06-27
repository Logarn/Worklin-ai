import { describe, expect, test } from "bun:test";

import {
  ASSISTANT_CHARACTER_PACK_IDS,
  ASSISTANT_CHARACTER_PROFILE_PATH,
  isAssistantCharacterProfile,
  type AssistantCharacterProfile,
} from "@/types/assistant-character-profile";
import { WORKLIN_AVATAR_CHOICES } from "@/components/avatar/assistant-character-packs";

describe("isAssistantCharacterProfile", () => {
  const profile: AssistantCharacterProfile = {
    assistantName: "Spiky Spark",
    characterPackId: "worklin",
    characterId: "spiky_spark",
    avatarStyle: "portrait_asset",
    faceBuilder: {
      skinTone: "yellow",
      eyes: "wide",
      brows: "soft",
      eyewear: "none",
      nose: "button",
      mouth: "smile",
      hair: "short",
      accessories: "none",
      lineStyle: "clean",
      background: "white",
    },
    portraitAssetUrl: "/images/avatars/spiky-spark.mp4",
    portraitPrompt: "Square product-avatar portrait of Spiky Spark.",
    personalityPreset: "playful",
    personalityText: "Playful, useful, and sharp.",
    role: "creative partner",
    tone: "Playful and useful.",
    bio: "Challenges weak assumptions without getting mean.",
    animationEnabled: true,
    accentColor: "#65B76C",
    voicePlaceholder: "Soft and persistent.",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };

  test("accepts a valid assistant character profile", () => {
    expect(isAssistantCharacterProfile(profile)).toBe(true);
  });

  test("rejects malformed sidecar data", () => {
    expect(isAssistantCharacterProfile(null)).toBe(false);
    expect(isAssistantCharacterProfile({ ...profile, characterPackId: "x" })).toBe(false);
    expect(isAssistantCharacterProfile({ ...profile, animationEnabled: "yes" })).toBe(false);
    expect(isAssistantCharacterProfile({ ...profile, personalityPreset: "mean" })).toBe(false);
    expect(isAssistantCharacterProfile({ ...profile, avatarStyle: "oil_paint" })).toBe(false);
    expect(
      isAssistantCharacterProfile({
        ...profile,
        faceBuilder: { ...profile.faceBuilder, skinTone: 123 },
      }),
    ).toBe(false);
  });
});

describe("assistant character profile constants", () => {
  test("stores profile data in the avatar workspace namespace", () => {
    expect(ASSISTANT_CHARACTER_PROFILE_PATH).toBe(
      "data/avatar/assistant-character-profile.json",
    );
  });

  test("defines the Worklin pack plus legacy character packs", () => {
    expect(ASSISTANT_CHARACTER_PACK_IDS).toEqual([
      "worklin",
      "rick_and_morty",
      "simpsons",
      "futurama",
    ]);
  });

  test("exposes only the six supplied Worklin video avatars", () => {
    expect(WORKLIN_AVATAR_CHOICES).toHaveLength(6);
    expect(WORKLIN_AVATAR_CHOICES.map((avatar) => avatar.id)).toEqual([
      "spiky_spark",
      "tin_grin",
      "dr_pinch",
      "sunny_square",
      "mystery_mutt",
      "orbit_wink",
    ]);
    expect(
      WORKLIN_AVATAR_CHOICES.every((avatar) =>
        avatar.portraitAssetUrl?.endsWith(".mp4"),
      ),
    ).toBe(true);
  });
});
