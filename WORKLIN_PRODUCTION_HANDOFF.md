# Worklin Production Handoff

Last refreshed: 2026-07-14

This is the single authoritative handoff for ongoing Worklin production work. Update this file in place. Do not create another dated handoff unless a separate immutable incident record is explicitly requested.

## Start Here

- Repo/worktree: `/Users/admin/Documents/New project 2/.tmp-worklin-redeploy`
- Branch: `main`
- Remote: `https://github.com/Logarn/Worklin-ai.git`
- Production frontend: `https://worklin-ai.vercel.app`
- Production backend/control plane: `https://worklin-ai-production.up.railway.app`
- Current `main` and `origin/main`: `191139d` (`Add evidence-based brand copy skill`)
- Artifact state: local-only and uncommitted unless a later task explicitly publishes it.

Read `AGENTS.md` before changing code. Preserve unrelated worktree changes and never put provider keys, browser cookies, project tokens, or other credentials in this file.

## Current Objective

Complete the private Hume live-voice pilot against the real Worklin chat experience while keeping Worklin as the canonical agent brain for memory, tools, permissions, and transcript persistence.

The immediate sequence is:

1. restore the existing test assistant through Worklin's shared runtime without upgrading Railway,
2. configure Hume through Worklin's secure credential flow,
3. run a real multi-turn voice test in production,
4. keep customer onboarding gated while shared-runtime mode is active, and
5. move back to isolated per-assistant runtimes before onboarding real users.

## Verified Production Snapshot

Verified on 2026-07-14:

- `main` and `origin/main` both resolve to `191139d`.
- GitHub commit status is successful for both Vercel and Railway.
- `GET https://worklin-ai-production.up.railway.app/healthz` returns HTTP 200 with `{"ok":true}`.
- `GET https://worklin-ai-production.up.railway.app/readyz` returns HTTP 200 with `{"ok":true,"gatewayStatus":200}`.
- `GET https://worklin-ai.vercel.app/assistant` returns HTTP 200.

Those checks prove that the shared deployment is online. They do not prove that the selected user's managed assistant runtime is active.

Authenticated production verification established the separate product state:

- the account has exactly one persisted hosted assistant,
- repeated session bootstrap does not create duplicates,
- the assistant is returned by the hosted assistant APIs,
- its runtime provider is Railway,
- its runtime status is `failed`, and
- the product displays the assistant as crash-looping because managed runtime provisioning is unavailable.

The original missing-assistant failure is fixed. The current blocker is runtime routing, not assistant identity creation.

## What Is Shipped

### Real-time voice UI

The production voice work is present on `main` across commits `1c7efdb` through `29c0d66`.

Current product intent:

- Live Voice is the sole voice entry point; the redundant dictation microphone was removed.
- The interface is integrated into the real chat composer rather than a separate mock dashboard.
- The visual treatment is a black background with a royal-blue voice visualization.
- Listening motion is driven by microphone amplitude.
- Speaking motion is driven by assistant playback amplitude.
- Typed and spoken turns belong to the same Worklin conversation.
- Completed turns must remain in chat after a voice session ends.
- Ending voice should finalize any completed user turn and preserve the conversation; it should not silently erase completed transcript history.

Primary files:

- `apps/web/src/domains/chat/components/live-voice-button.tsx`
- `apps/web/src/domains/chat/voice/live-voice/`
- `apps/web/src/domains/chat/voice/live-voice/voice-conversation-panel.tsx`
- `apps/web/src/domains/chat/voice/live-voice/use-live-voice.ts`

### Hosted Hume pilot bridge

Commit `faf7a5f` (`Wire hosted Hume voice pilot`) added:

- an internal setup panel in Developer settings,
- secure credential writes for the Hume API key and secret key,
- assistant voice configuration for EVI config and voice IDs,
- enablement of the `voice-mode` feature flag, and
- a signed provider callback that routes Hume's custom-language-model request to the selected Worklin runtime.

Primary files:

- `apps/web/src/domains/settings/components/panels/live-voice-pilot-panel.tsx`
- `apps/web/src/domains/settings/pages/developer-page.tsx`
- `control-plane/src/live-voice-provider-callback.ts`
- `control-plane/src/live-voice-provider-callback.test.ts`
- `control-plane/src/index.ts`

The setup panel requires four values:

- Hume API key,
- Hume secret key,
- EVI config ID,
- voice ID.

The API key previously shared in chat is intentionally absent from this repository and handoff. Rotate it after the pilot as planned.

### Default assistant for every account

Commit `18fd162` (`Ensure every account has an assistant`) fixed the zero-assistant state.

Current behavior:

- authenticated session bootstrap idempotently creates the default assistant identity,
- assistant list and active-assistant APIs backfill the identity when necessary,
- repeated bootstrap remains one assistant and one organization,
- consent gates runtime provisioning rather than identity existence,
- hatch no longer fails before an assistant record can be created, and
- unavailable provisioning produces a persisted assistant with a failed runtime instead of an empty account or endless hatching loop.

Primary files:

- `control-plane/src/assistant-store.ts`
- `control-plane/src/assistant-store.test.ts`
- `control-plane/src/index.ts`
- `apps/web/src/assistant/lifecycle.ts`
- `apps/web/src/assistant/lifecycle.test.ts`

### Gated Railway runtime provisioning

Commit `8fe7ae2` added safe-by-default isolated runtime provisioning.

The provisioner creates one Railway service and one volume per assistant. It remains inert unless all required configuration is present, including explicit enablement and a positive service cap.

Required isolated-runtime configuration:

- `WORKLIN_RAILWAY_PROVISIONING_ENABLED=true`
- `WORKLIN_RAILWAY_PROJECT_TOKEN`
- `WORKLIN_RAILWAY_PROJECT_ID`
- `WORKLIN_RAILWAY_ENVIRONMENT_ID`
- `WORKLIN_RAILWAY_MAX_RUNTIME_SERVICES` set to an explicitly approved positive value

Primary files:

- `control-plane/src/railway-runtime-provisioner.ts`
- `control-plane/src/railway-runtime-provisioner.test.ts`
- `control-plane/src/runtime-stacks.ts`
- `control-plane/src/runtime-stacks.test.ts`
- `runtime/entrypoint.sh`

## Current Blocker

The production Railway service currently has the normal Auth0 and Worklin base variables, but none of the isolated-runtime provisioning variables listed above.

Railway also blocks project-token creation until the account is verified. Its verification flow redirects to plan/billing setup. No plan selection, payment action, project-token creation, or runtime-service cap change has been authorized or performed.

Because the control plane defaults to isolated runtimes and has no usable project credential, it correctly fails closed. The assistant identity exists, but its runtime row is failed and unroutable.

## Approved Direction: Shared Runtime For The Private Pilot

The private pilot can avoid the Railway account upgrade by explicitly routing the test assistant through the already-running shared Worklin gateway.

Intended pilot-only configuration:

```text
WORKLIN_REQUIRE_ISOLATED_RUNTIME=false
WORKLIN_ALLOW_LEGACY_SHARED_RUNTIME=true
```

This is not the production architecture for future users. While shared-runtime mode is active:

- customer onboarding must remain gated,
- the pilot must stay limited to internal testers,
- no claim of per-user runtime isolation should be made, and
- the configuration must not be copied into isolated child runtimes.

### Required recovery before enabling the flags

Changing the two environment variables alone is insufficient for the existing assistant.

`ensureRuntimeStackForAssistant()` returns an existing runtime row unchanged. The persisted row is already a failed Railway stack, so it will not automatically become a `legacy_shared` active stack after an environment change.

Implement and test a narrow, idempotent recovery path that may rebind a stack only when all of these are true:

- shared-runtime mode is explicitly enabled,
- isolated runtime is explicitly disabled,
- the existing stack is `failed` or `provisioning`,
- provider is Railway,
- `gateway_url` is empty,
- `service_ref` is empty, and
- `workspace_volume_ref` is empty.

The recovery must refuse to rebind any stack that already owns a Railway service or volume. That prevents orphaning billable infrastructure.

The repaired row should become:

- status `active`,
- provider `legacy_shared`,
- gateway URL equal to `WORKLIN_GATEWAY_URL`,
- service reference `legacy-shared-runtime`, and
- last error cleared.

Likely implementation surface:

- `control-plane/src/runtime-stacks.ts`
- `control-plane/src/runtime-stacks.test.ts`
- `control-plane/src/index.ts`

## Internal-Allowlist Follow-Up

`LiveVoicePilotPanel` currently writes `pilotAllowlist: ["*"]`. That is broader than the planned internal-only pilot boundary.

Before treating voice mode as available beyond the single test account:

- replace the wildcard with the actual internal tester identity or a server-controlled allowlist,
- verify `voice-mode` is evaluated server-side as well as in the UI, and
- confirm a non-allowlisted account cannot bootstrap a provider voice session.

Do not broaden the pilot merely because the Developer settings panel is less visible than normal settings.

## Next Execution Plan

### Phase 1: recover the private test assistant

1. Add the guarded failed-stack-to-shared-runtime recovery described above.
2. Add tests proving:
   - an unallocated failed Railway row can recover,
   - recovery is idempotent,
   - an allocated service is never rebound,
   - an allocated volume is never rebound, and
   - isolated defaults still fail closed.
3. Run focused control-plane tests and typecheck.
4. Deploy the code.
5. Add the two pilot-only shared-runtime variables to the production control-plane service.
6. Verify the existing assistant becomes `active` with provider `legacy_shared` and the shared gateway remains healthy.

Environment-variable changes are production infrastructure mutations. Reconfirm the pilot-only scope immediately before saving them.

### Phase 2: configure Hume securely

1. Open Worklin Developer settings for the active assistant.
2. Obtain the Hume secret key, EVI config ID, and voice ID from the authenticated Hume account.
3. Enter all four values only through Worklin's Live Voice Pilot panel.
4. Confirm the API and secret keys are stored by the credential service and are never returned to the renderer.
5. Confirm the assistant config selects Hume and `voice-mode` is enabled for the test account.

Do not paste Hume credentials into source files, shell history, logs, or this handoff.

### Phase 3: production voice test

Run the test in the existing Worklin conversation:

1. accept the one-time AI voice/audio-processing disclosure,
2. start Live Voice and grant microphone permission,
3. complete at least three alternating user/assistant turns,
4. confirm live partial transcripts are readable while speaking,
5. confirm final transcripts settle without duplicated turns,
6. confirm the royal-blue visualization follows mic amplitude while listening,
7. confirm it follows actual assistant playback amplitude while speaking,
8. interrupt the assistant mid-response and verify local playback stops immediately,
9. end the voice session and confirm completed turns remain in chat,
10. refresh the conversation and confirm transcript persistence,
11. confirm approval-required tools pause and cannot run solely from spoken confirmation, and
12. confirm no raw pilot audio is archived by Worklin.

Capture separately:

- end-of-turn to first audible response,
- provider interruption event to local playback stop,
- reconnect behavior after a provider disconnect, and
- behavior after microphone denial.

### Phase 4: production isolation before real users

Before onboarding external users:

1. verify the Railway account or choose another infrastructure provider,
2. create the server-side project credential,
3. enable isolated provisioning,
4. set an explicit, conservative runtime-service cap with user approval,
5. disable legacy shared runtime,
6. migrate the private pilot assistant to an isolated runtime,
7. rerun the assistant lifecycle, voice, interruption, approval, and transcript suites, and
8. only then remove the onboarding gate.

## Focused Verification Commands

Never run an unscoped `bun test` in this repository.

Control plane:

```bash
cd "/Users/admin/Documents/New project 2/.tmp-worklin-redeploy/control-plane"
PATH="$HOME/.bun/bin:$PATH" bun test src/assistant-store.test.ts src/runtime-stacks.test.ts src/railway-runtime-provisioner.test.ts src/live-voice-provider-callback.test.ts
PATH="$HOME/.bun/bin:$PATH" bunx tsc --noEmit
```

Web lifecycle and voice:

```bash
cd "/Users/admin/Documents/New project 2/.tmp-worklin-redeploy/apps/web"
PATH="$HOME/.bun/bin:$PATH" bun test \
  src/assistant/lifecycle.test.ts \
  src/domains/chat/components/live-voice-button.test.tsx \
  src/domains/chat/voice/live-voice/connection.test.ts \
  src/domains/chat/voice/live-voice/live-voice-client.test.ts \
  src/domains/chat/voice/live-voice/pcm-capture.test.ts \
  src/domains/chat/voice/live-voice/protocol.test.ts \
  src/domains/chat/voice/live-voice/tts-playback.test.ts \
  src/domains/chat/voice/live-voice/use-live-voice.test.ts \
  src/domains/chat/voice/live-voice/voice-conversation-panel.test.tsx
PATH="$HOME/.bun/bin:$PATH" bun run typecheck
```

Live deployment split:

```bash
curl -i https://worklin-ai-production.up.railway.app/healthz
curl -i https://worklin-ai-production.up.railway.app/readyz
curl -I https://worklin-ai.vercel.app/assistant
```

Treat those checks as deploy health only. Authenticated assistant APIs and the visible chat/voice behavior are separate release gates.

## Current Worktree Protection

There is active, unrelated brand-brain and retention work in this worktree. It does not belong to the runtime/voice recovery and must not be staged, reverted, rewritten, or absorbed into a handoff commit.

At handoff refresh time, that unrelated dirt includes changes under:

- `assistant/src/config/bundled-skills/worklin-brand-brain/`
- `assistant/src/memory/brand-brain-store*`
- `assistant/src/memory/migrations/291-retention-brand-brains.ts`
- `assistant/src/tools/retention/brand-brain-tools*`
- `assistant/src/tools/retention/worklin-retention.ts`
- `assistant/src/tools/skills/load.ts`
- `assistant/src/config/bundled-tool-registry.ts`
- `assistant/src/daemon/conversation-process.ts`
- `packages/retention-domain/src/`
- `skills/write-brand-copy/`
- `skills/catalog.json`

Re-run `git status --short --branch` before editing or staging because this list may change.

## Safety Boundaries

- Never expose Hume, ElevenLabs, provider, Auth0, Railway, or Worklin secrets to a renderer or repo file.
- Do not create a Railway project token without action-time confirmation.
- Do not select a paid plan, add payment information, or change a cost-bearing runtime cap on the user's behalf.
- Do not enable shared runtime for customer traffic.
- Do not let spoken approval bypass Worklin's normal confirmation UI.
- Do not archive raw pilot audio in Worklin.
- Preserve interrupted assistant output using existing partial/cancelled-message semantics.
- Keep one active voice session per user; a second surface should report the active session rather than opening another microphone/provider connection.

## Paste-Ready Prompt For A Fresh Codex Chat

```text
Continue Worklin production work from:
/Users/admin/Documents/New project 2/.tmp-worklin-redeploy

Read AGENTS.md and WORKLIN_PRODUCTION_HANDOFF.md completely before acting. WORKLIN_PRODUCTION_HANDOFF.md is the only authoritative handoff; dated handoffs were intentionally removed.

Current main/origin main is 191139d. Vercel, Railway, /healthz, /readyz, and the frontend /assistant route are healthy, but the authenticated account's persisted assistant runtime is failed because isolated Railway provisioning is not configured. The missing-assistant bug itself was fixed in 18fd162: every authenticated account now gets exactly one default assistant identity.

The approved pilot direction is to use Worklin's existing shared runtime temporarily, without upgrading Railway. Do not simply set the environment flags: the current failed Railway runtime row will remain unchanged. First implement a narrow, idempotent recovery for failed or provisioning Railway rows that have no service, no volume, and no gateway. It may rebind those rows to the shared gateway only when WORKLIN_REQUIRE_ISOLATED_RUNTIME=false and WORKLIN_ALLOW_LEGACY_SHARED_RUNTIME=true. It must refuse to rebind allocated infrastructure.

Add focused runtime-stack tests, run the control-plane suite and typecheck, and preserve all unrelated brand-brain/retention worktree changes. Stop before saving production environment variables and reconfirm the pilot-only infrastructure change with the user.

After the assistant is active, configure Hume only through Worklin's Live Voice Pilot developer panel using the Hume API key, secret key, EVI config ID, and voice ID. Never place those values in files or logs. Replace or constrain the current wildcard pilot allowlist before any broader exposure.

Then run the three-turn production voice test, interruption test, transcript persistence check, end-session check, approval safety check, and latency measurements documented in WORKLIN_PRODUCTION_HANDOFF.md. Shared runtime is internal-pilot-only; customer onboarding remains gated until isolated per-assistant runtimes are configured and revalidated.
```
