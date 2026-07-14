# Worklin Production Handoff

Last refreshed: 2026-07-14

This is the single authoritative handoff for ongoing Worklin production work. Update it in place. Do not create another dated handoff unless a separate immutable incident record is explicitly requested.

## Start Here

- Repo/worktree: `/Users/admin/Documents/New project 2/.tmp-worklin-redeploy`
- Branch: `main`
- Remote: `https://github.com/Logarn/Worklin-ai.git`
- Production frontend: `https://worklin-ai.vercel.app`
- Production backend/runtime: `https://worklin-ai-production.up.railway.app`
- Current production application commit: `17d2e6e` (`Document UI consistency rollout boundary`), including the system-access fix and assistant/live-voice UI consistency pass
- Browser requirement for the pilot: use the authenticated Chrome profile selected by the user. Do not switch to Safari or the in-app browser.

Read `AGENTS.md` before changing code. Preserve unrelated worktree changes. Never put provider keys, browser cookies, signed connection URLs, session tokens, or other credentials in this file.

## Current Skills And System-Access Fix

The existing Worklin system-access settings remain the single permission model. The current local fix does not add a second permissions UI or a new account type.

- Plain skill discovery, catalog installation, and loading are setup operations and are allowed under every system-access preset, including Strict.
- Read-only `brand_brain_read` context injection is allowed under every preset so persisted onboarding Brand Brain data can load without a misleading approval popup.
- A skill load that expands inline commands remains executable behavior: it prompts under Strict and follows the user's selected system-access threshold at other levels, including Full Access.
- Tools and external actions exposed by a loaded skill continue through the existing risk rules and the user's selected system-access level.
- Explicit deny rules continue to win before these safe-operation exceptions.
- The internal `guardian` trust/schema identifiers remain temporarily for database and protocol compatibility, but they are not user account roles and must never be shown to users.
- User-facing surfaces now say `You`, `account owner`, `Approval Request`, or `account verification` as appropriate.
- The channel setup intent router recognizes the new account-verification wording while retaining legacy phrase recognition for existing conversations.

The role model requested for future team accounts is `admin`, `manager`, and `collaborator`, with the workspace creator becoming the initial admin. That team-membership model is separate from this compatibility fix and is not implemented by relabeling the internal trust class.

Files at the core of this change:

- `assistant/src/permissions/approval-policy.ts`
- `assistant/src/permissions/checker.ts`
- `assistant/src/tools/skills/load.ts` (existing catalog auto-install path, behavior verified)
- `assistant/src/daemon/verification-session-intent.ts`
- `apps/web/src/domains/contacts/components/contact-type-badge.tsx`
- `apps/web/src/domains/contacts/contacts-page.tsx`

### Verification For The Skills And System-Access Fix

Passed locally on 2026-07-14:

- 179 focused permission, approval-copy, channel, and verification tests.
- 77 verification-intent and pointer-message tests.
- 36 real `skill_load` tests, including catalog auto-install and persisted Brand Brain injection.
- Focused tool-approval, verification-policy, call, ACP, invite, relay, and Contacts badge suites.
- Assistant and web TypeScript checks.
- Targeted assistant and web lint; zero errors, with one pre-existing hooks warning in `contacts-page.tsx`.
- Production-mode web build using `VITE_PLATFORM_MODE=true bun run build`.
- `git diff --check`.

Deployment status: pushed and deployed through `17d2e6e` on 2026-07-14. Railway recovered with healthy gateway readiness, and a fresh production text turn returned `Worklin is ready.`, confirming the configured LLM credential survived the restart.

## Assistant And Live-Voice UI Consistency Pass

Production commit `5653385` unifies the assistant and live-voice visual language around the black-and-royal-blue Worklin orb. It shipped as part of application deployment `17d2e6e` on 2026-07-14.

The consistency pass:

- replaces the legacy green blob as the default/abstract assistant identity with one shared royal-blue `WorklinOrb`,
- keeps explicit user-uploaded images and intentionally selected modern character avatars,
- removes the legacy blob renderer, legacy avatar builder, and old classic-avatar picker paths,
- uses the same orb in chat, assistant identity, favicon/Dock fallbacks, live-voice entry, and live-voice state visualization,
- keeps the live-voice panel present in the composer while idle, showing `Ready` before a session begins,
- replaces the redundant microphone glyph with the Worklin orb,
- preserves live partial/final transcripts and input-driven listening/output-driven speaking motion,
- changes the empty-conversation heading to `What should we work on?`, and
- keeps terminal Hume provider errors visible and retryable rather than making the voice interface disappear.

Verified locally on 2026-07-14:

- 76 focused chat/avatar/live-voice/electron-icon tests passed with zero failures.
- Web TypeScript check passed.
- Targeted web lint passed with zero errors and one pre-existing `slash` dependency warning in `chat-composer.tsx`.
- Production-mode Vite build passed with `VITE_PLATFORM_MODE=1 ./node_modules/.bin/vite build --configLoader native`.
- Chrome visual verification passed on the full black Worklin dashboard preview: Ready, Listening, Thinking, Speaking, Interrupted, transcripts, and End Voice all use the shared royal-blue treatment without a microphone glyph.
- `git diff --check` passed.

Verified in authenticated production Chrome on 2026-07-14:

- the new-conversation screen shows the Worklin orb and `What should we work on?`,
- the live-voice transcript region remains present in `Ready` with `Start a live conversation.`,
- the voice entry control contains 19 orb bars and zero SVG/microphone glyphs,
- the Your Assistant identity card and capability graph use the Worklin orb instead of the legacy green blob,
- the avatar modal offers `Worklin orb`, modern character choices, uploads, and generation without the classic/blob builder, and
- the production alias serves the same `index-D6Lb41Zo.js` bundle as the successful Vercel deployment.

## Current Objective And Blocker

The private Hume live-voice pilot is wired through the real production Worklin composer. Worklin remains the canonical agent brain for memory, tools, permissions, and transcript persistence.

The current external blocker is Hume billing, not Worklin connectivity:

- Hume accepted Worklin's production WebSocket connection.
- Hume then returned error `E0300`: `Exhausted credit balance. Visit platform.hume.ai/billing to manage your account.`
- Hume Billing now shows `0 minutes remaining` and `EVI limit exceeded` on the active free plan. The account had five free EVI minutes at the start of this test; the continuously connected listening session consumed that allowance while the microphone/connection path was being diagnosed.
- The spoken multi-turn, interruption, transcript-persistence, and latency gates cannot be completed until the user adds Hume credits.
- Do not select a plan, add payment information, or alter Hume billing on the user's behalf.

## Verified Production Snapshot

Verified on 2026-07-14:

- Application changes through `17d2e6e` were pushed to `main` and `origin/main`.
- `GET https://worklin-ai-production.up.railway.app/healthz` returned HTTP 200 with `{"ok":true}`.
- `GET https://worklin-ai-production.up.railway.app/readyz` returned HTTP 200 with `{"ok":true,"gatewayStatus":200}`.
- `GET https://worklin-ai.vercel.app/assistant` returned HTTP 200.
- Vercel deployment `worklin-exmunv6fv-sautionlineai-3596s-projects.vercel.app` completed successfully for `17d2e6e`.
- The stale `worklin-ai.vercel.app` alias was repointed to that deployment and verified to serve the same main asset bundle.
- A fresh post-restart production text turn returned `Worklin is ready.`, confirming LLM generation and credential persistence.
- The updated assistant identity, empty-chat, voice Ready panel, orb entry control, and avatar picker were verified in authenticated Chrome.
- Vercel deployment `dpl_2Cup8MVp5966L4g5Yf5yaCgPKYjB` completed successfully for the error-visibility commit.
- The stale `worklin-ai.vercel.app` alias was repointed from its older deployment to that Ready production deployment.
- The corrected production UI was verified in Chrome: `Voice unavailable` and Hume's exhausted-credit message remain visible, while `Start voice mode` stays retryable.
- The production Worklin account resolves a persisted assistant; the prior zero-assistant state is fixed.
- The production Live Voice setup panel is available for the allowlisted user and stores Hume credentials through Worklin's server-side credential path.
- Hume configuration completed successfully in Worklin without exposing provider secrets to the renderer or repository.

Recent production commits relevant to this pilot include:

- `7971b05` — scope shared runtime to the pilot assistant.
- `eb1ff26` — unblock guarded Hume pilot setup.
- `af12c21` — preserve providers on billing errors.
- `29c7cd9` — bundle the feature-flag registry in the runtime image.
- `a7ba866` — update provider test SDK mocks.
- `5aa7e5f` — keep terminal provider failures visible and retryable in the composer.

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

### 0. Deploy the skills and terminology fix after restart confirmation

1. Commit only the reviewed skills/system-access/terminology files and this handoff.
2. Get explicit confirmation immediately before pushing because Railway will restart the shared runtime.
3. Push `main`, watch Vercel and Railway deployment health separately, then verify `/healthz`, `/readyz`, and `/assistant`.
4. Confirm the Kimi connection still exists after the runtime restart without exposing or re-entering the key on the user's behalf.
5. Run an authenticated copy task and confirm Brand Brain context and the copywriting skill load without an approval popup.
6. Confirm Contacts and approval/channel copy contain no user-facing `Guardian` or `non-guardian` account labels.

### 1. User action: restore Hume credits

The user must manage the Hume account's billing/credits. Stop at that gate. Do not act on the user's behalf.

The user also planned to rotate the temporary Hume credential after testing. Never repeat the credential previously shared in chat, and never place it in source, logs, commands, or documentation.

### 2. Error-state deployment completed

Completed on 2026-07-14:

1. Vercel built `5aa7e5f` successfully.
2. The production alias was corrected to the new Ready deployment.
3. One zero-credit voice attempt returned Hume `E0300`.
4. The shared panel stayed visible with `Voice unavailable` and the provider error.
5. `Start voice mode` stayed available while the microphone and session lease were released.

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
- Before commit, inspect `git status` and stage only the reviewed files for the active change plus this canonical handoff.

## Paste-Ready Prompt For A Fresh Codex Chat

```text
Continue Worklin production work from:
/Users/admin/Documents/New project 2/.tmp-worklin-redeploy

Read AGENTS.md and WORKLIN_PRODUCTION_HANDOFF.md completely before acting. WORKLIN_PRODUCTION_HANDOFF.md is the only authoritative handoff; do not create another dated handoff.

The private Hume pilot is configured through Worklin and production connectivity is proven: Worklin bootstrap returned 200, Hume WebSocket returned 101, session_settings/chat_metadata exchanged, Chrome granted the built-in microphone, Worklin showed Listening, and 16 kHz audio_input frames streamed. The current external blocker is Hume error E0300: exhausted credit balance. Stop at that billing gate; the user must add credits.

The app also hid the provider error because ChatComposer unmounted VoiceConversationPanel for failed state. A tested fix keeps the failed panel visible with Voice unavailable plus the provider message while leaving the retry button available. Verify the commit/deploy status first and preserve all unrelated worktree changes.

A separate tested local fix now reuses Worklin's existing system-access settings: plain/catalog skill installation and loading plus read-only Brand Brain access do not ask for approval, while inline-command skill loads and tools/actions still follow the selected access level. User-facing legacy Guardian terminology has been replaced with You/account owner/account verification; internal identifiers remain only for compatibility. This fix is not deployed yet. Confirm the Railway restart before pushing, then verify Kimi credential persistence and run a live authenticated copy test.

After credits exist, run the documented three-turn Hume test, real-time transcript check, output-driven speaking visualization check, barge-in latency measurement, end-session and refresh persistence checks, duplicate-session rejection, approval safety test, and no-raw-audio confirmation. Use the authenticated Chrome profile requested by the user; do not switch to Safari or the in-app browser. Never repeat or expose provider credentials.
```
