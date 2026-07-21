import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const originalAudioContext = Object.getOwnPropertyDescriptor(
  window,
  "AudioContext",
);

mock.module("@/domains/settings/api/sounds", () => ({
  fetchSoundFile: mock(async () => null),
}));

const { getSoundManager } = await import(
  "@/domains/settings/utils/sound-manager"
);

beforeEach(() => {
  getSoundManager().setFeatureEnabled(true);
});

afterAll(() => {
  getSoundManager().setFeatureEnabled(false);
  if (originalAudioContext) {
    Object.defineProperty(window, "AudioContext", originalAudioContext);
  } else {
    Reflect.deleteProperty(window, "AudioContext");
  }
  mock.restore();
});

describe("SoundManager preview feedback", () => {
  test("reports unsupported when Web Audio is unavailable", async () => {
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: undefined,
    });

    await expect(
      getSoundManager().previewFallbackBlip(0.7),
    ).resolves.toBe("unsupported");
  });

  test("reports blocked when the browser rejects audio context resume", async () => {
    const resumeMock = mock(async () => {
      throw new DOMException("Playback blocked", "NotAllowedError");
    });
    class BlockedAudioContext {
      state: AudioContextState = "suspended";
      resume = resumeMock;
    }
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: BlockedAudioContext,
    });

    await expect(
      getSoundManager().previewFallbackBlip(0.7),
    ).resolves.toBe("blocked");
    expect(resumeMock).toHaveBeenCalledTimes(1);
  });
});
