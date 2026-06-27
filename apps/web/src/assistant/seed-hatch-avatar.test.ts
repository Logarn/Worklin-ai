/**
 * Tests for `seedHatchAvatar` — the shared hatch-avatar seed used by both the
 * standalone hatching screen and the cast flow's background hatch.
 *
 * Pins:
 *   - Saves a Worklin avatar profile + invalidates the avatar query when no avatar exists yet.
 *   - Falls back to saving traits if profile persistence fails.
 *   - Skips the save (but still invalidates) when an avatar already exists, so
 *     a returning user's uploaded/AI image is never clobbered.
 *   - Swallows transport failures (fire-and-forget).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { CharacterTraits } from "@/types/avatar";
import type { AssistantCharacterProfile } from "@/types/assistant-character-profile";

const fetchAssistantCharacterProfileMock = mock(
  async (_id: string): Promise<AssistantCharacterProfile | null> => null,
);
const fetchCharacterTraitsMock = mock(
  async (_id: string): Promise<CharacterTraits | null> => null,
);
const saveAssistantCharacterProfileMock = mock(
  async (
    _id: string,
    _profile: AssistantCharacterProfile,
  ): Promise<boolean> => true,
);
const saveCharacterTraitsMock = mock(
  async (_id: string, _t: CharacterTraits): Promise<boolean> => true,
);
mock.module("@/assistant/avatar-api", () => ({
  fetchAssistantCharacterProfile: fetchAssistantCharacterProfileMock,
  fetchCharacterTraits: fetchCharacterTraitsMock,
  saveAssistantCharacterProfile: saveAssistantCharacterProfileMock,
  saveCharacterTraits: saveCharacterTraitsMock,
}));
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));
mock.module("@/lib/sync/query-tags", () => ({
  avatarQueryKey: (id: string) => ["avatar", id],
}));

const { seedHatchAvatar } = await import("./seed-hatch-avatar");
const { WORKLIN_AVATAR_CHOICES } = await import(
  "@/components/avatar/assistant-character-packs"
);

const TRAITS: CharacterTraits = {
  bodyShape: "round",
  eyeStyle: "happy",
  color: "#123456",
};

function makeQueryClient(): {
  invalidateQueries: ReturnType<typeof mock>;
} {
  return { invalidateQueries: mock(() => {}) };
}

beforeEach(() => {
  fetchAssistantCharacterProfileMock.mockClear();
  fetchCharacterTraitsMock.mockClear();
  saveAssistantCharacterProfileMock.mockClear();
  saveCharacterTraitsMock.mockClear();
  fetchAssistantCharacterProfileMock.mockResolvedValue(null);
  fetchCharacterTraitsMock.mockResolvedValue(null);
  saveAssistantCharacterProfileMock.mockResolvedValue(true);
  saveCharacterTraitsMock.mockResolvedValue(true);
});

describe("seedHatchAvatar", () => {
  test("saves a Worklin avatar profile and invalidates when no avatar exists", async () => {
    fetchAssistantCharacterProfileMock.mockResolvedValueOnce(null);
    fetchCharacterTraitsMock.mockResolvedValueOnce(null);
    const qc = makeQueryClient();

    await seedHatchAvatar("ast-1", TRAITS, qc as never);

    expect(saveAssistantCharacterProfileMock).toHaveBeenCalledTimes(1);
    expect(saveAssistantCharacterProfileMock.mock.calls[0]?.[0]).toBe("ast-1");
    expect(
      saveAssistantCharacterProfileMock.mock.calls[0]?.[1]?.characterPackId,
    ).toBe("worklin");
    expect(saveCharacterTraitsMock).not.toHaveBeenCalled();
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  test("uses the onboarding-selected avatar when one is supplied", async () => {
    const qc = makeQueryClient();
    const preferredAvatar = WORKLIN_AVATAR_CHOICES.find(
      (avatar) => avatar.id === "orbit_wink",
    );

    await seedHatchAvatar("ast-1", TRAITS, qc as never, preferredAvatar);

    expect(saveAssistantCharacterProfileMock).toHaveBeenCalledTimes(1);
    expect(
      saveAssistantCharacterProfileMock.mock.calls[0]?.[1]?.characterId,
    ).toBe("orbit_wink");
    expect(saveCharacterTraitsMock).not.toHaveBeenCalled();
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  test("falls back to traits when the profile save fails", async () => {
    saveAssistantCharacterProfileMock.mockResolvedValueOnce(false);
    const qc = makeQueryClient();

    await seedHatchAvatar("ast-1", TRAITS, qc as never);

    expect(saveAssistantCharacterProfileMock).toHaveBeenCalledTimes(1);
    expect(saveCharacterTraitsMock).toHaveBeenCalledTimes(1);
    expect(saveCharacterTraitsMock.mock.calls[0]?.[0]).toBe("ast-1");
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  test("skips the save but still invalidates when avatar traits already exist", async () => {
    fetchAssistantCharacterProfileMock.mockResolvedValueOnce(null);
    fetchCharacterTraitsMock.mockResolvedValueOnce(TRAITS);
    const qc = makeQueryClient();

    await seedHatchAvatar("ast-1", TRAITS, qc as never);

    expect(saveAssistantCharacterProfileMock).not.toHaveBeenCalled();
    expect(saveCharacterTraitsMock).not.toHaveBeenCalled();
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  test("skips the save but still invalidates when an avatar profile already exists", async () => {
    fetchAssistantCharacterProfileMock.mockResolvedValueOnce({
      assistantName: "Tin Grin",
      characterPackId: "worklin",
      characterId: "tin_grin",
      avatarStyle: "portrait_asset",
      personalityPreset: "blunt",
      personalityText: "Dry and useful.",
      role: "operator",
      tone: "Dry and practical.",
      bio: "Keeps work moving.",
      animationEnabled: true,
      updatedAt: "2026-06-20T00:00:00.000Z",
    });
    const qc = makeQueryClient();

    await seedHatchAvatar("ast-1", TRAITS, qc as never);

    expect(saveAssistantCharacterProfileMock).not.toHaveBeenCalled();
    expect(saveCharacterTraitsMock).not.toHaveBeenCalled();
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  test("swallows transport failures", async () => {
    fetchAssistantCharacterProfileMock.mockRejectedValueOnce(new Error("boom"));
    const qc = makeQueryClient();

    await seedHatchAvatar("ast-1", TRAITS, qc as never);

    expect(saveAssistantCharacterProfileMock).not.toHaveBeenCalled();
    expect(saveCharacterTraitsMock).not.toHaveBeenCalled();
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
  });
});
