# Worklin Platform-Hosting Fix Status (2026-06-29)

## What I changed

- File changed:
  - `apps/web/src/lib/local-mode.ts`
    - In `isLocalMode()`, `VITE_PLATFORM_MODE` now defaults to **platform mode** when unset.
    - Before: missing `VITE_PLATFORM_MODE` returned `true` (local/self-hosted by default).
    - After: missing value returns `false` (platform-hosted by default), with explicit local-mode only when env is set to `0`, `false`, `no`, or other non-truthy values.
    - In plain terms: this removes the “web app falls back into local/self-hosted behavior by default” regression.

## Why this was done

- Product direction is now explicit that Worklin web should be **platform-hosted only**.
- This fixes the root cause behind contradictory UI states:
  - `/assistant` showing self-hosted shell
  - settings and onboarding surfaces acting as if no hosted assistant is available
  - edit/profile flows inheriting mixed self-hosted/hosted assistant behavior

## Validation run in this rig

- `bunx tsc --noEmit` ✅
- `bunx eslint src/lib/local-mode.ts src/assistant/api.ts` ✅
- `bun test src/lib/local-mode.test.ts` ✅ (21 passed)
- `bun test src/assistant/lifecycle-service.test.ts src/assistant/lifecycle.test.ts`
  - Ran successfully up to an existing pre-existing failure in `src/assistant/lifecycle.test.ts` (`errorRetryDelayMs` expected value mismatch), and expected mock-throw traces in transport-failure paths.
  - No new failures introduced by this one-line host-default change.

## Current branch / PR status snapshot

- Working branch: `codex/worklin-sentry-upload-guard`
- Merged PRs (already live in mainline):
  - #72 — merged
  - #71 — merged (hosted assistant resolution work)
  - #69 and below for associated earlier platform/runtime fixes
- Open PR:
  - #70 — currently open (avatar onboarding; unchanged by this patch)

## What is still pending

- No code config/runtime changes have been made in this pass beyond the one-line hosting-mode default change.
- Not yet done:
  - Deploying this commit to Vercel branch and promoting to production
  - Re-running a full live QA pass against the production alias (`https://worklin-ai.vercel.app`) and direct Vercel deployment URL after deployment
  - Verifying that the previously failing pages now resolve in hosted mode:
    - `/assistant`
    - `/assistant/settings/general`
    - `/assistant/onboarding/hatching` behavior
    - data failures in integrations/schedules/privacy/archive/billing/debug
- If those live checks still fail after deployment, next likely fix points are:
  - API return values (`is_local`/hosted assistant payload correctness),
  - settings data endpoints/auth headers for live account scope,
  - and any remaining self-hosted fallbacks still gating platform routes.

## Action to continue

- Open a new PR from this branch including the above file change only, then run production deploy and immediately execute the live smoke/QA pass.
