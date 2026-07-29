import { describe, expect, test } from "bun:test";

import type { IdentityGetResponse } from "@/generated/daemon/types.gen";
import type { AssistantCharacterProfile } from "@/types/assistant-character-profile";

import { resolveIdentityCardFields } from "./identity-card-fields";

const persistedIdentity: IdentityGetResponse = {
  name: "North Star",
  role: "Lifecycle marketing partner",
  personality: "Clear, curious, and candid",
  emoji: ":sparkles:",
  home: "",
  version: "0.8.12",
};

const avatarProfile = {
  assistantName: "Avatar default",
  role: "Research partner",
  personalityText: "Playful",
} as AssistantCharacterProfile;

describe("resolveIdentityCardFields", () => {
  test("uses persisted identity metadata ahead of avatar presentation defaults", () => {
    expect(resolveIdentityCardFields(persistedIdentity, avatarProfile)).toEqual({
      name: "North Star",
      role: "Lifecycle marketing partner",
      personality: "Clear, curious, and candid",
    });
  });

  test("falls back to avatar defaults while canonical identity fields are unset", () => {
    expect(
      resolveIdentityCardFields(
        {
          ...persistedIdentity,
          name: "",
          role: "",
          personality: "",
        },
        avatarProfile,
      ),
    ).toEqual({
      name: "Avatar default",
      role: "Research partner",
      personality: "Playful",
    });
  });
});
