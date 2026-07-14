/**
 * Copy constants for the chat empty state.
 *
 * Shared by the web and native chat surfaces.
 */

export const DEFAULT_EMPTY_STATE_GREETING =
  "What should we work on?";

export const EMPTY_STATE_PLACEHOLDERS: readonly string[] = [
  "Paste your brand website...",
  "Ask Worklin to onboard a brand...",
  "Start a retention audit...",
  "Connect Klaviyo when you’re ready...",
  "Tell Worklin what you sell...",
] as const;

export const MAX_CONVERSATION_STARTER_CHIPS = 4;

/**
 * Returns one entry from {@link EMPTY_STATE_PLACEHOLDERS}, chosen by the
 * provided rng (defaults to {@link Math.random}). The rng must return a
 * value in `[0, 1)`.
 */
export function pickRandomPlaceholder(
  rng: () => number = Math.random,
): string {
  const index = Math.floor(rng() * EMPTY_STATE_PLACEHOLDERS.length);
  return EMPTY_STATE_PLACEHOLDERS[index]!;
}
