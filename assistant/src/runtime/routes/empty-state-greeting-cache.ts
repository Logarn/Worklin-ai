/**
 * Caching layer for the empty-state (new-chat) greeting generated via the
 * `POST /v1/btw` side-chain with `conversationKey: "greeting"`.
 *
 * Stores a single greeting string with a configurable TTL
 * (`ui.emptyStateGreetingCacheTtlMs`, default 4h). A TTL of `0` (or less)
 * disables caching entirely — reads always miss and writes are skipped — so
 * the greeting regenerates on every request. This is the knob a workspace
 * sets to always receive a fresh greeting.
 *
 * Storage uses the existing `memory_checkpoints` table (simple key-value
 * store), mirroring {@link ./identity-intro-cache.ts}.
 */

import { getConfig } from "../../config/loader.js";
import {
  deleteMemoryCheckpoint,
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../../memory/checkpoints.js";
import {
  getIdentityChangeEpoch,
  onIdentityChange,
} from "../../workspace/identity-change-invalidation.js";

const CHECKPOINT_KEY_TEXT = "empty_state:greeting:text";
const CHECKPOINT_KEY_TIMESTAMP = "empty_state:greeting:cached_at";
const CHECKPOINT_KEY_IDENTITY_EPOCH = "empty_state:greeting:identity_epoch";

function cacheTtlMs(): number {
  return getConfig().ui.emptyStateGreetingCacheTtlMs;
}

/**
 * Return the cached greeting if present and within the configured TTL.
 * Returns `null` when caching is disabled (TTL <= 0), the cache is empty,
 * or the entry has expired.
 */
export function getCachedEmptyStateGreeting(): string | null {
  const ttl = cacheTtlMs();
  if (ttl <= 0) return null; // caching disabled — always regenerate

  try {
    const text = getMemoryCheckpoint(CHECKPOINT_KEY_TEXT);
    const timestampStr = getMemoryCheckpoint(CHECKPOINT_KEY_TIMESTAMP);
    const identityEpochStr = getMemoryCheckpoint(CHECKPOINT_KEY_IDENTITY_EPOCH);
    if (!text || !timestampStr || !identityEpochStr) return null;
    if (Number(identityEpochStr) !== getIdentityChangeEpoch()) return null;

    const cachedAt = Number(timestampStr);
    if (Number.isNaN(cachedAt) || Date.now() - cachedAt > ttl) return null;

    return text;
  } catch {
    return null;
  }
}

/**
 * Store a freshly generated greeting along with the current timestamp.
 * No-ops when caching is disabled (TTL <= 0) so a zero-TTL workspace never
 * writes a stale entry.
 */
export function setCachedEmptyStateGreeting(
  text: string,
  expectedIdentityEpoch = getIdentityChangeEpoch(),
): boolean {
  if (cacheTtlMs() <= 0) return false;
  if (expectedIdentityEpoch !== getIdentityChangeEpoch()) return false;

  try {
    setMemoryCheckpoint(CHECKPOINT_KEY_TEXT, text);
    setMemoryCheckpoint(CHECKPOINT_KEY_TIMESTAMP, String(Date.now()));
    setMemoryCheckpoint(
      CHECKPOINT_KEY_IDENTITY_EPOCH,
      String(expectedIdentityEpoch),
    );
    if (expectedIdentityEpoch !== getIdentityChangeEpoch()) {
      clearCachedEmptyStateGreeting();
      return false;
    }
    return true;
  } catch {
    // Cache write failure is non-fatal — next request will regenerate.
    return false;
  }
}

export function clearCachedEmptyStateGreeting(): void {
  try {
    deleteMemoryCheckpoint(CHECKPOINT_KEY_TEXT);
    deleteMemoryCheckpoint(CHECKPOINT_KEY_TIMESTAMP);
    deleteMemoryCheckpoint(CHECKPOINT_KEY_IDENTITY_EPOCH);
  } catch {
    // Cache invalidation is best-effort; epoch validation still rejects it.
  }
}

onIdentityChange(clearCachedEmptyStateGreeting);
