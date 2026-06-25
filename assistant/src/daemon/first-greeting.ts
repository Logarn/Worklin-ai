import { existsSync } from "node:fs";

import { getWorkspacePromptPath } from "../util/platform.js";

type Tone = "grounded" | "warm" | "energetic" | "poetic";

export interface OnboardingGreetingContext {
  tools: string[];
  tasks: string[];
  /** Valid values: "grounded" | "warm" | "energetic" | "poetic" */
  tone: string;
  userName?: string;
  assistantName?: string;
  googleConnected?: boolean;
}

/**
 * Returns `true` when all of the following are true:
 * - `conversationMessageCount === 0` (no prior messages in this conversation)
 * - BOOTSTRAP.md exists at the workspace prompt path
 * - The trimmed content matches the macOS wake-up greeting (case-insensitive)
 */
export function isWakeUpGreeting(
  content: string,
  conversationMessageCount: number,
): boolean {
  if (conversationMessageCount !== 0) return false;
  if (!existsSync(getWorkspacePromptPath("BOOTSTRAP.md"))) return false;
  return (
    content
      .trim()
      .toLowerCase()
      .replace(/[.!?]+$/, "") === "wake up, my friend"
  );
}

export function getCannedFirstGreeting(
  onboarding?: OnboardingGreetingContext,
): string {
  if (onboarding) {
    return buildPersonalizedGreeting(onboarding);
  }
  return CANNED_FIRST_GREETING;
}

/**
 * Builds a natural self-introduction to send *on behalf of the user* in place
 * of the wake-up greeting, so the assistant generates a real response instead
 * of replaying canned copy. Names come from the onboarding context; missing
 * names are dropped so the line stays natural:
 *   - both:           "Hi Vela, I'm alex. Nice to meet you."
 *   - assistant only: "Hi Vela. Nice to meet you."
 *   - user only:      "Hi, I'm alex. Nice to meet you."
 * When neither name is known there is nothing personal to say, so this returns
 * `undefined` and the caller falls back to the canned greeting.
 */
export function buildSelfIntroMessage(
  onboarding?: OnboardingGreetingContext,
): string | undefined {
  const assistant = onboarding?.assistantName?.trim();
  const user = onboarding?.userName?.trim();
  if (!assistant && !user) return undefined;
  const hi = assistant ? `Hi ${assistant}` : "Hi";
  const intro = user ? `, I'm ${user}` : "";
  return `${hi}${intro}. Nice to meet you.`;
}

const TONE_INTRO_CLOSE: Record<Tone, string> = {
  grounded: "",
  warm: "Good to meet you.",
  energetic: "Let's map the account.",
  poetic: "",
};

function buildIntroLine(
  name?: string,
  assistant?: string,
  tone: Tone = "grounded",
): string {
  const greeting = name ? `Hey ${name},` : "Hey,";
  const who = assistant ? `I'm ${assistant}.` : "";
  const close = assistant ? TONE_INTRO_CLOSE[tone] : "";
  return [greeting, who, close].filter(Boolean).join(" ");
}

// Every greeting variant -- the no-onboarding CANNED greeting and all four
// personalized tones -- ends with a concrete onboarding first step. The opener
// and the first-step ask are kept as separate per-tone maps and composed in
// `buildInvite`, rather than inlined as one full sentence per variant, so the
// guided setup ask cannot be silently dropped when the opener copy is edited.
const TONE_INVITE_OPENER: Record<Tone, string> = {
  grounded: "I'll guide setup one simple question at a time.",
  warm:
    "I'll keep setup simple and ask one question at a time.",
  energetic:
    "Let's set up the brand without making you figure out what I need.",
  poetic:
    "We'll turn the blank start into one simple next question.",
};

const TONE_ONBOARDING_FIRST_STEP: Record<Tone, string> = {
  grounded:
    "First question: what is the brand website?",
  warm:
    "First question: paste the brand website and I'll take it from there.",
  energetic:
    "First question: drop the brand website and I'll start mapping the account.",
  poetic:
    "First question: what is the brand website? That gives us a clean place to start.",
};

const TONE_GOOGLE_SCAN: Record<Tone, string> = {
  grounded:
    "If Klaviyo or Shopify is already connected, I can fold that data into the audit once we finish the brand basics.",
  warm:
    "If Klaviyo or Shopify is already connected, I can use it after the brand basics so the audit starts from real account data.",
  energetic:
    "If Klaviyo or Shopify is already connected, I can pull it into the audit as soon as the brand basics are set.",
  poetic:
    "If Klaviyo or Shopify is already connected, I can weave those signals into the first audit after the brand basics.",
};

function buildInvite(tone: Tone = "grounded"): string {
  return `${TONE_INVITE_OPENER[tone]} ${TONE_ONBOARDING_FIRST_STEP[tone]}`;
}

// Composed from the grounded opener + onboarding first step so the no-onboarding
// greeting reuses the same source as the personalized grounded greeting rather
// than duplicating the copy. Defined after the tone maps so they are
// initialized before this module-level evaluation runs.
export const CANNED_FIRST_GREETING = [
  "Hey, I'm Worklin -- your autonomous retention marketing agent.",
  "",
  buildInvite("grounded"),
].join("\n");

const VALID_TONES = new Set<string>([
  "grounded",
  "warm",
  "energetic",
  "poetic",
]);

function resolveTone(raw?: string): Tone {
  return raw && VALID_TONES.has(raw) ? (raw as Tone) : "grounded";
}

export function buildScanFirstMessage(
  url: string,
  variant: "website" | "content-source",
): string {
  if (variant === "content-source") {
    return `Here's a page with content I'd like you to look at: ${url}`;
  }
  return `Here's my website: ${url}`;
}

function buildPersonalizedGreeting(ctx: OnboardingGreetingContext): string {
  const name = ctx.userName?.trim();
  const assistant = ctx.assistantName?.trim();
  const tone = resolveTone(ctx.tone);

  if (
    !name &&
    !assistant &&
    !VALID_TONES.has(ctx.tone) &&
    !ctx.googleConnected
  ) {
    return CANNED_FIRST_GREETING;
  }

  const intro = buildIntroLine(name, assistant, tone);
  const invite = buildInvite(tone);
  const parts = [intro, "", invite];
  if (ctx.googleConnected) {
    parts.push("", TONE_GOOGLE_SCAN[tone]);
  }
  return parts.join("\n");
}
