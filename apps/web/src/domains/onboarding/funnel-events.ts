import { readShareAnalytics } from "@/domains/onboarding/prefs";
import { resolvePlatformActionUrl } from "@/lib/api-origins";
import { getClientId } from "@/lib/telemetry/client-identity";

export const ONBOARDING_FUNNEL_VERSION = "onboarding_v3_2026_05";
const SESSION_STORAGE_KEY = "onboarding.funnelSessionId";
const VARIANT_STORAGE_KEY = "onboarding.funnelVariant";

export const ONBOARDING_FUNNEL_VARIANTS = {
  control: "control",
  paredDown: "pared_down",
  // The cast / personal-page activation arm is a distinct arm, not part of the
  // control/pared-down A/B split. Cast funnel steps report this deterministic
  // label so they are never conflated with a stale stored control/variant value.
  cast: "cast",
} as const;

export type OnboardingFunnelVariant =
  (typeof ONBOARDING_FUNNEL_VARIANTS)[keyof typeof ONBOARDING_FUNNEL_VARIANTS];

export function onboardingFunnelVariantFromExperiment(
  experimentArm: string,
): OnboardingFunnelVariant {
  return experimentArm === "variant-a"
    ? ONBOARDING_FUNNEL_VARIANTS.paredDown
    : ONBOARDING_FUNNEL_VARIANTS.control;
}

export const ONBOARDING_FUNNEL_STEPS = {
  privacyTos: { stepName: "privacy_tos", stepIndex: 0 },
  nameVibe: { stepName: "name_vibe", stepIndex: 1 },
  controlWorkType: { stepName: "work_type", stepIndex: 2 },
  controlTools: { stepName: "tools", stepIndex: 3 },
  controlPriorAssistants: { stepName: "prior_assistants", stepIndex: 4 },
  controlGmailConnect: { stepName: "gmail_connect", stepIndex: 5 },
  controlGetApp: { stepName: "get_app", stepIndex: 6 },
  gmailConnect: { stepName: "gmail_connect", stepIndex: 2 },
  // Cast (personal-page arm) flow. Indices are local to this walk.
  castLogin: { stepName: "cast_login", stepIndex: 0 },
  castPreamble: { stepName: "cast_preamble", stepIndex: 1 },
  castStarter: { stepName: "cast_starter", stepIndex: 2 },
  castDialogue: { stepName: "cast_dialogue", stepIndex: 3 },
  // Keep the terminal index stable for funnel aggregation. Index 4 is no
  // longer emitted because the flow moves directly from dialogue to done.
  castDone: { stepName: "cast_done", stepIndex: 5 },
} as const;

export type OnboardingFunnelStep =
  (typeof ONBOARDING_FUNNEL_STEPS)[keyof typeof ONBOARDING_FUNNEL_STEPS];

export type OnboardingFunnelStepName = OnboardingFunnelStep["stepName"];

export interface OnboardingFunnelStepCompletedOptions {
  userId?: string | null;
  variant?: OnboardingFunnelVariant;
}

export interface OnboardingFunnelEvent {
  type: "onboarding";
  daemon_event_id: string;
  recorded_at: number;
  screen: OnboardingFunnelStepName;
  session_id: string;
  step_name: OnboardingFunnelStepName;
  step_index: number;
  completed_at: string;
  user_id: string | null;
  funnel_version: string;
  ab_variant: OnboardingFunnelVariant;
}

const PLATFORM_MODE_TRUTHY = new Set(["1", "true", "yes"]);

function isHostedPlatformMode(
  raw = import.meta.env.VITE_PLATFORM_MODE,
  isProduction = import.meta.env.PROD,
): boolean {
  return isProduction && raw
    ? PLATFORM_MODE_TRUTHY.has(raw.toLowerCase())
    : false;
}

export function shouldEmitBrowserOnboardingTelemetry(
  platformMode = import.meta.env.VITE_PLATFORM_MODE,
  isProduction = import.meta.env.PROD,
): boolean {
  // Hosted Worklin proxies /v1/* to the production control-plane, while the
  // telemetry ingest endpoint is a daemon-to-platform route. Do not create a
  // browser-visible 404 for a best-effort event that cannot be ingested there.
  return !isHostedPlatformMode(platformMode, isProduction);
}

function stripUndefined(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

export function getOnboardingFunnelSessionId(): string {
  if (typeof window === "undefined") return crypto.randomUUID();
  let existing = "";
  try {
    existing = sessionStorage.getItem(SESSION_STORAGE_KEY) ?? "";
  } catch {
    existing = "";
  }
  if (existing) return existing;
  const next = crypto.randomUUID();
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, next);
  } catch {
    // Storage may be unavailable; the current event still carries a valid id.
  }
  return next;
}

function isOnboardingFunnelVariant(
  value: string | null,
): value is OnboardingFunnelVariant {
  return (
    value === ONBOARDING_FUNNEL_VARIANTS.control ||
    value === ONBOARDING_FUNNEL_VARIANTS.paredDown ||
    value === ONBOARDING_FUNNEL_VARIANTS.cast
  );
}

export function readOnboardingFunnelVariant(): OnboardingFunnelVariant | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = sessionStorage.getItem(VARIANT_STORAGE_KEY);
    return isOnboardingFunnelVariant(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function resolveOnboardingFunnelVariant(
  preferred: OnboardingFunnelVariant,
): OnboardingFunnelVariant {
  const existing = readOnboardingFunnelVariant();
  if (existing) return existing;
  if (typeof window === "undefined") return preferred;
  try {
    sessionStorage.setItem(VARIANT_STORAGE_KEY, preferred);
  } catch {
    // Storage may be unavailable; the current event still carries the variant.
  }
  return preferred;
}

export function buildOnboardingFunnelEvent(
  screen: OnboardingFunnelStep,
  options: OnboardingFunnelStepCompletedOptions = {},
): OnboardingFunnelEvent {
  const now = Date.now();
  const variant =
    options.variant ??
    readOnboardingFunnelVariant() ??
    ONBOARDING_FUNNEL_VARIANTS.control;
  return {
    type: "onboarding",
    daemon_event_id: crypto.randomUUID(),
    recorded_at: now,
    screen: screen.stepName,
    session_id: getOnboardingFunnelSessionId(),
    step_name: screen.stepName,
    step_index: screen.stepIndex,
    completed_at: new Date(now).toISOString(),
    user_id: options.userId ?? null,
    funnel_version: ONBOARDING_FUNNEL_VERSION,
    ab_variant: variant,
  };
}

export function emitOnboardingFunnelStepCompleted(
  screen: OnboardingFunnelStep,
  options: OnboardingFunnelStepCompletedOptions = {},
): void {
  if (typeof window === "undefined") return;
  if (!readShareAnalytics()) return;
  if (!shouldEmitBrowserOnboardingTelemetry()) return;

  const event = stripUndefined(buildOnboardingFunnelEvent(screen, options));

  const payload = JSON.stringify({
    device_id: getClientId(),
    assistant_version: import.meta.env.VITE_APP_VERSION ?? "web-dev",
    events: [event],
  });

  const telemetryUrl = resolvePlatformActionUrl("/v1/telemetry/ingest/");

  void fetch(telemetryUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    credentials: "include",
    keepalive: true,
  }).catch(() => {});
}

export function __resetOnboardingFunnelEventsForTests(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    sessionStorage.removeItem(VARIANT_STORAGE_KEY);
  } catch {
    // ignore
  }
}
