/**
 * Web sound playback manager.
 *
 * Mirrors the macOS `SoundManager` so the web client honours the same
 * globalEnabled, per-event enabled, and volume semantics. The pool of
 * sounds for an event plays in random order — when the pool is empty or
 * the referenced file cannot be loaded, a short synthesised "blip" is
 * played via the Web Audio API as a parity fallback for the macOS
 * default Tink.
 */

import { fetchSoundFile } from "@/domains/settings/api/sounds";
import {
  type SoundEventId,
  type SoundsConfig,
  validateSoundFilename,
} from "@/domains/settings/types/sounds";

interface CachedSound {
  url: string;
}

export type SoundPreviewResult =
  | "played"
  | "played-fallback"
  | "blocked"
  | "unsupported"
  | "disabled";

type FilePlaybackResult = "played" | "blocked" | "failed";
type FallbackPlaybackResult = "played" | "blocked" | "unsupported";

function hasErrorName(error: unknown, name: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === name
  );
}

function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 0.7;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

class SoundManager {
  private assistantId: string | null = null;
  private config: SoundsConfig | null = null;
  private featureEnabled = false;
  private cache = new Map<string, CachedSound>();
  private pendingFetches = new Map<string, Promise<CachedSound | null>>();
  private audioContext: AudioContext | null = null;

  setAssistantId(assistantId: string | null): void {
    if (assistantId === this.assistantId) return;
    this.assistantId = assistantId;
    this.clearCache();
  }

  setConfig(config: SoundsConfig | null): void {
    this.config = config;
  }

  setFeatureEnabled(enabled: boolean): void {
    this.featureEnabled = enabled;
  }

  async play(event: SoundEventId): Promise<void> {
    if (!this.featureEnabled) return;
    const config = this.config;
    if (!config || !config.globalEnabled) return;

    const eventConfig = config.events[event];
    if (!eventConfig?.enabled) return;

    const volume = clampVolume(config.volume);
    const pool = eventConfig.sounds.filter(validateSoundFilename);

    if (pool.length === 0) {
      void this.playFallbackBlip(volume);
      return;
    }

    const filename = pool[Math.floor(Math.random() * pool.length)];
    if (!filename) {
      void this.playFallbackBlip(volume);
      return;
    }
    const result = await this.playFile(filename, volume);
    if (result !== "played") {
      void this.playFallbackBlip(volume);
    }
  }

  async previewSound(
    filename: string,
    volumeOverride?: number,
  ): Promise<SoundPreviewResult> {
    if (!this.featureEnabled) return "disabled";
    const volume = clampVolume(volumeOverride ?? this.config?.volume ?? 0.7);
    const fileResult = await this.playFile(filename, volume);
    if (fileResult === "played") return "played";

    const fallbackResult = await this.playFallbackBlip(volume);
    if (fallbackResult === "played") return "played-fallback";
    if (fileResult === "blocked") return "blocked";
    return fallbackResult;
  }

  async previewFallbackBlip(
    volumeOverride?: number,
  ): Promise<SoundPreviewResult> {
    if (!this.featureEnabled) return "disabled";
    const volume = clampVolume(volumeOverride ?? this.config?.volume ?? 0.7);
    return this.playFallbackBlip(volume);
  }

  clearCache(): void {
    for (const cached of this.cache.values()) {
      URL.revokeObjectURL(cached.url);
    }
    this.cache.clear();
    this.pendingFetches.clear();
  }

  private async playFile(
    filename: string,
    volume: number,
  ): Promise<FilePlaybackResult> {
    if (!validateSoundFilename(filename)) return "failed";
    try {
      const cached = await this.getOrFetch(filename);
      if (!cached) return "failed";
      const audio = new Audio(cached.url);
      audio.volume = volume;
      await audio.play();
      return "played";
    } catch (error) {
      return hasErrorName(error, "NotAllowedError") ? "blocked" : "failed";
    }
  }

  private async getOrFetch(filename: string): Promise<CachedSound | null> {
    const hit = this.cache.get(filename);
    if (hit) return hit;

    const inFlight = this.pendingFetches.get(filename);
    if (inFlight) return inFlight;

    const assistantId = this.assistantId;
    if (!assistantId) return null;

    const promise = (async () => {
      try {
        const blob = await fetchSoundFile(assistantId, filename);
        if (!blob) return null;
        const url = URL.createObjectURL(blob);
        const entry: CachedSound = { url };
        this.cache.set(filename, entry);
        return entry;
      } finally {
        this.pendingFetches.delete(filename);
      }
    })();
    this.pendingFetches.set(filename, promise);
    return promise;
  }

  private async playFallbackBlip(
    volume: number,
  ): Promise<FallbackPlaybackResult> {
    if (typeof window === "undefined") return "unsupported";
    try {
      const AudioContextCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioContextCtor) return "unsupported";
      if (!this.audioContext) {
        this.audioContext = new AudioContextCtor();
      }
      const ctx = this.audioContext;
      if (ctx.state === "suspended") {
        await ctx.resume();
      }
      if (ctx.state !== "running") return "blocked";

      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, ctx.currentTime);

      const peak = Math.max(0, Math.min(1, volume)) * 0.25;
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(peak, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);

      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.2);
      return "played";
    } catch {
      return "blocked";
    }
  }
}

let singleton: SoundManager | null = null;

export function getSoundManager(): SoundManager {
  if (!singleton) {
    singleton = new SoundManager();
  }
  return singleton;
}
