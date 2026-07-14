# Worklin Production Handoff

Last refreshed: 2026-07-14

This is the single authoritative handoff for ongoing Worklin production work. Update it in place. Do not create another dated handoff unless a separate immutable incident record is explicitly requested.

## Start Here

- Repo/worktree: `/Users/admin/Documents/New project 2/.tmp-worklin-redeploy`
- Branch: `main`
- Remote: `https://github.com/Logarn/Worklin-ai.git`
- Production frontend: `https://worklin-ai.vercel.app`
- Production backend/runtime: `https://worklin-ai-production.up.railway.app`
- Latest voice change: `Keep live voice provider errors visible` (the commit that contains this handoff)
- Browser requirement for the pilot: use the authenticated Chrome profile selected by the user. Do not switch to Safari or the in-app browser.

Read `AGENTS.md` before changing code. Preserve unrelated worktree changes. Never put provider keys, browser cookies, signed connection URLs, session tokens, or other credentials in this file.

## Current Objective And Blocker

The private Hume live-voice pilot is wired through the real production Worklin composer. Worklin remains the canonical agent brain for memory, tools, permissions, and transcript persistence.

The current external blocker is Hume billing, not Worklin connectivity:

- Hume accepted Worklin's production WebSocket connection.
- Hume then returned error `E0300`: `Exhausted credit balance. Visit platform.hume.ai/billing to manage your account.`
- The spoken multi-turn, interruption, transcript-persistence, and latency gates cannot be completed until the user adds Hume credits.
- Do not select a plan, add payment information, or alter Hume billing on the user's behalf.

## Verified Production Snapshot

Verified on 2026-07-14:

- `main` and `origin/main` both resolved to `a7ba866` before the local error-visibility fix was committed.
- `GET https://worklin-ai-production.up.railway.app/healthz` returned HTTP 200 with `{"ok":true}`.
- `GET https://worklin-ai-production.up.railway.app/readyz` returned HTTP 200 with `{"ok":true,"gatewayStatus":200}`.
- `GET https://worklin-ai.vercel.app/assistant` returned HTTP 200.
- The production Worklin account resolves a persisted assistant; the prior zero-assistant state is fixed.
- The production Live Voice setup panel is available for the allowlisted user and stores Hume credentials through Worklin's server-side credential path.
- Hume configuration completed successfully in Worklin without exposing provider secrets to the renderer or repository.

Recent production commits relevant to this pilot include:

- `7971b05` — scope shared runtime to the pilot assistant.
- `eb1ff26` — unblock guarded Hume pilot setup.
- `af12c21` — preserve providers on billing errors.
- `29c7cd9` — bundle the feature-flag registry in the runtime image.
- `a7ba866` — update provider test SDK mocks.
- `Keep live voice provider errors visible` — keep terminal provider failures visible and retryable in the composer.

The shared runtime is internal-pilot-only. Customer onboarding must remain gated until isolated per-assistant runtimes and their safety suite are restored.

## Production Hume Test Evidence

The authenticated production test reached all of these stages:

1. Worklin session bootstrap returned HTTP 200.
2. The browser opened `wss://api.hume.ai/v0/evi/chat` using Worklin's short-lived connection payload.
3. The WebSocket handshake returned HTTP 101 `Switching Protocols`.
4. Worklin sent Hume `session_settings` with the signed Worklin session binding.
5. Hume returned `chat_metadata`.
6. Chrome granted the production Worklin origin access to the built-in MacBook microphone.
7. Worklin entered the visible `Listening` state and streamed 16 kHz PCM `audio_input` frames.
8. A later restart completed another HTTP 101 handshake, after which Hume returned `E0300` and closed the socket.

No raw pilot audio was written to Worklin, the repo, or this handoff. Only transient protocol types, status codes, and timing/state evidence were inspected.

## Why The Hume Interface Disappeared

The production app did receive Hume's billing error and moved the live-voice store to `failed`. The composer intentionally unmounted the shared voice panel for every `failed` state, so the actionable error vanished and the normal start button reappeared. To the user this looked as if the Hume interface had simply disappeared.

A local fix now:

- keeps the shared voice panel mounted for `failed`,
- displays the existing `Voice unavailable` label and provider error,
- releases the microphone/socket/session as before, and
- keeps the live-voice start button retryable.

Files changed:

- `apps/web/src/domains/chat/components/chat-composer/chat-composer.tsx`
- `apps/web/src/domains/chat/components/chat-composer/chat-composer.test.tsx`

## Verification For The Error-Visibility Fix

Passed on 2026-07-14:

```bash
cd "/Users/admin/Documents/New project 2/.tmp-worklin-redeploy/apps/web"
bun test src/domains/chat/components/chat-composer/chat-composer.test.tsx
bun test src/domains/chat/voice/live-voice/voice-conversation-panel.test.tsx
bun test src/domains/chat/voice/live-voice/use-live-voice.test.ts
bun run typecheck
bun run lint \
  src/domains/chat/components/chat-composer/chat-composer.tsx \
  src/domains/chat/components/chat-composer/chat-composer.test.tsx
```

Results:

- 54 chat-composer tests passed.
- 3 shared-panel tests passed.
- 12 live-voice controller tests passed.
- TypeScript passed.
- ESLint reported zero errors and one pre-existing `react-hooks/exhaustive-deps` warning at `chat-composer.tsx:336`, unrelated to this change.

Run the three Bun test files in separate processes. Bun's global `mock.module` state causes the composer store mock to contaminate the controller suite when all three files share one process.

## Next Execution Steps

### 1. User action: restore Hume credits

The user must manage the Hume account's billing/credits. Stop at that gate. Do not act on the user's behalf.

The user also planned to rotate the temporary Hume credential after testing. Never repeat the credential previously shared in chat, and never place it in source, logs, commands, or documentation.

### 2. Deploy and verify the error-state fix

After the error-visibility commit is deployed:

1. wait for the Vercel deployment to become ready,
2. confirm the production alias points to the new deployment rather than an older pinned build,
3. start voice with insufficient credits once if needed,
4. verify the panel stays visible with `Voice unavailable` and the provider error, and
5. verify the retry button is available while the microphone and session lease are released.

Do not repeatedly spend provider credits or create overlapping microphone sessions while checking the failure state.

### 3. Resume the real Hume test after credits exist

Use a new conversation or a clean persisted conversation and run:

1. start Live Voice and confirm `Listening`,
2. complete at least three alternating user/assistant turns,
3. confirm readable partial and final user transcripts without duplicate finals,
4. confirm the royal-blue visualization follows microphone amplitude while listening,
5. confirm it follows actual assistant playback amplitude while speaking,
6. interrupt the assistant mid-response and measure provider-event-to-local-stop latency,
7. end the session and confirm completed turns remain in chat,
8. refresh and confirm transcript persistence,
9. trigger an approval-required action and confirm voice alone cannot approve it,
10. confirm a second surface cannot acquire another microphone/provider session, and
11. confirm Worklin archives no raw pilot audio.

Targets:

- median end-of-turn to first audible response: at or below 1.5 seconds,
- p95 end-of-turn to first audible response: at or below 3 seconds,
- provider interruption event to local playback stop: at or below 250 ms.

### 4. Release B

ElevenLabs remains deferred until Hume Release A passes the same-conversation in-app and overlay gates. It must use the same provider-neutral UI/session bridge and server-side signed connection model.

## Important Product State

- Every authenticated Worklin account should receive exactly one default assistant identity; repeated bootstrap must stay idempotent.
- Live Voice replaces one-shot dictation in the eligible composer; do not reintroduce a second microphone button.
- The shared black/royal-blue panel is used by the in-app composer and the macOS overlay.
- Listening animation uses microphone amplitude; speaking animation uses actual playback amplitude.
- Ending voice releases the microphone, audio context, provider connection, and session lease while preserving completed chat turns.
- Approval-required tools must pause and direct the user to Worklin's normal approval UI.
- The Hume pilot allowlist is written for the authenticated user, not `*`.
- Managed/BYOK customer settings, billing, quotas, entitlements, and voice credits are not part of this pilot.

## Safety Boundaries

- Never expose Hume, ElevenLabs, Auth0, Railway, Worklin, or other provider secrets to a renderer or repo file.
- Never inspect or export browser cookies, local storage contents, or browser profile data.
- Do not manage billing, accept legal terms, create paid infrastructure, or select plans for the user.
- Do not enable shared runtime for customer traffic.
- Do not let spoken approval bypass Worklin's normal confirmation UI.
- Do not archive raw pilot audio in Worklin.
- Preserve interrupted assistant output using existing partial/cancelled-message semantics.
- Keep one active voice session per user. A second surface reports the active session instead of opening another microphone or provider connection.
- Before commit, inspect `git status` and stage only the two web files plus this canonical handoff.

## Paste-Ready Prompt For A Fresh Codex Chat

```text
Continue Worklin production work from:
/Users/admin/Documents/New project 2/.tmp-worklin-redeploy

Read AGENTS.md and WORKLIN_PRODUCTION_HANDOFF.md completely before acting. WORKLIN_PRODUCTION_HANDOFF.md is the only authoritative handoff; do not create another dated handoff.

The private Hume pilot is configured through Worklin and production connectivity is proven: Worklin bootstrap returned 200, Hume WebSocket returned 101, session_settings/chat_metadata exchanged, Chrome granted the built-in microphone, Worklin showed Listening, and 16 kHz audio_input frames streamed. The current external blocker is Hume error E0300: exhausted credit balance. Stop at that billing gate; the user must add credits.

The app also hid the provider error because ChatComposer unmounted VoiceConversationPanel for failed state. A tested fix keeps the failed panel visible with Voice unavailable plus the provider message while leaving the retry button available. Verify the commit/deploy status first and preserve all unrelated worktree changes.

After credits exist, run the documented three-turn Hume test, real-time transcript check, output-driven speaking visualization check, barge-in latency measurement, end-session and refresh persistence checks, duplicate-session rejection, approval safety test, and no-raw-audio confirmation. Use the authenticated Chrome profile requested by the user; do not switch to Safari or the in-app browser. Never repeat or expose provider credentials.
```
