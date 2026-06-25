import { describe, expect, test } from "bun:test";

import {
  ASSISTANT_CHARACTER_PACK_IDS,
  ASSISTANT_CHARACTER_PROFILE_PATH,
  isAssistantCharacterProfile,
  type AssistantCharacterProfile,
} from "@/types/assistant-character-profile";

describe("isAssistantCharacterProfile", () => {
  const profile: AssistantCharacterProfile = {
    assistantName: "Ralph",
    characterPackId: "simpsons",
    characterId: "ralph",
    avatarStyle: "face_builder",
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
    portraitPrompt: "Square transparent PNG avatar portrait of Ralph.",
    personalityPreset: "playful",
    personalityText: "Gentle, simple, and persistent.",
    role: "operator",
    tone: "Simple and useful.",
    bio: "Keeps looping until the task is done.",
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

  test("defines the three requested TV character packs", () => {
    expect(ASSISTANT_CHARACTER_PACK_IDS).toEqual([
      "rick_and_morty",
      "simpsons",
      "futurama",
    ]);
  });
});
