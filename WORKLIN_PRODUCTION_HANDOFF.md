# Worklin Production Handoff

Last refreshed: 2026-07-22

This is the single authoritative handoff for ongoing Worklin production work. Update it in place. Do not create another dated handoff unless a separate immutable incident record is explicitly requested.

## Start Here

- Repo/worktree: `/Users/admin/Documents/New project 2/.tmp-worklin-redeploy`
- Active implementation branch: `assistant/pooled-runtime-beta`; current `origin/main` (`614715f`, `Make conversation title generation reliable with BYOK fallback`) is merged in `29a66ad`; draft PR `#139` remains open. The previous pushed head `43aae19` completed every mandatory GitHub check, but that result predates `29a66ad`, so the current head still requires its own full CI cycle.
- Remote: `https://github.com/Logarn/Worklin-ai.git`
- Production frontend: `https://worklin-ai.vercel.app`
- Production backend/runtime: `https://worklin-ai-production.up.railway.app`
- Current production application commit: `614715f` (`Make conversation title generation reliable with BYOK fallback`), deployed on 2026-07-22. The public Vercel alias was repointed to the Ready production deployment `worklin-g3aqio4b4-sautionlineai-3596s-projects.vercel.app` so `worklin-ai.vercel.app` serves the current frontend bundle.
- Browser requirement for the pilot: use the authenticated Chrome profile selected by the user. Do not switch to Safari or the in-app browser.

Read `AGENTS.md` before changing code. Preserve unrelated worktree changes. Never put provider keys, browser cookies, signed connection URLs, session tokens, or other credentials in this file.

## 2026-07-22 Conversation Storage Recovery Verified

The production chat failure reported on 2026-07-21 was reproduced in the authenticated Chrome profile. The assistant page initially showed `Failed to load conversation history`, and sending a normal message produced `disk I/O error`. Browser logs also captured `database disk image is malformed` and HTTP 500/502 conversation-history failures. The runtime health check had been able to report ready because it checked the assistant daemon but not the SQLite database that served conversation history.

Commit `d2fcb55` adds two recovery boundaries:

- Assistant `/readyz` now probes SQLite with `SELECT 1` and `PRAGMA quick_check(1)`. A runtime with unreadable storage reports HTTP 503 with `storage_unavailable` instead of advertising readiness.
- The control plane now probes the runtime `/readyz` after a Railway-backed upstream application error. When the runtime is unhealthy, it marks the stack failed, schedules the existing Railway recovery path, and returns a user-safe 503 provisioning response rather than forwarding the raw 500.

Focused verification passed: assistant storage-readiness and identity routes `29/29`, assistant TypeScript and lint checks, control-plane runtime-provisioning `14/14`, Railway provisioner `16/16`, and control-plane TypeScript. GitHub reported both Vercel and Railway deployments successful for `d2fcb55`.

Authenticated live production acceptance also passed after deployment:

1. Sent `Live production smoke test: reply with exactly READY, then one short sentence describing your role.`
2. The assistant replied `READY` followed by its role sentence in approximately two seconds.
3. Reloaded the same conversation route and confirmed the user message and assistant response were loaded from persisted history.

Residual operational boundary: the recovery path redeploys and revalidates the existing Railway runtime. If a persistent volume is irreparably corrupt, the user will receive a clean provisioning/recovery state, but an operator may still need to replace or restore that volume. Do not describe a successful readiness probe as proof that old corrupted data has been repaired; the live authenticated turn and reload persistence check remain the product acceptance gates.

## 2026-07-22 Conversation Title Persistence Repaired

Production conversation titles were still showing `Untitled Conversation` after a reload. The failure was in the title side effect, not the sidebar cache: title generation resolved one provider route, and its error handler only replaced the initial `Generating title...` placeholder. Once a failed attempt had written `Untitled Conversation`, later failures left that title in place indefinitely.

Commit `614715f` fixes the title path narrowly:

- Interactive conversations try the bound conversation profile, `custom-cost-optimized`, and the active user-owned BYOK profile in order. A stale model, missing credential, provider-resolution error, or failed sidechain request can fall through to the next user-owned profile without silently switching a user to a managed profile.
- Provider profiles that specify only a provider or `provider_connection` are treated as usable because model settings may be inherited from the default layer.
- Any provider failure or unusable title response now falls back to a short readable title derived from the user's message, rather than `Untitled Conversation`. The fallback remains replaceable so a later successful LLM pass can improve it.
- The replaceability guard still protects manual conversation names, while old `Untitled Conversation` rows can repair themselves on the next user message.

Focused verification passed in isolated assistant processes: conversation-title service `24/24`, title hooks `18/18`, provider override routing `8/8`, assistant TypeScript, ESLint, and Prettier. A combined Bun invocation is not a canonical gate because global module mocks contaminate the queue suite across files.

Authenticated Chrome production verification passed after the alias correction:

1. Reloaded an existing production conversation that was still named `Untitled Conversation`.
2. Sent `Create a concise launch plan for a B2B email campaign.`
3. Confirmed the assistant returned a useful launch plan and the conversation changed live to `B2B Email Campaign Plan`.
4. Reloaded the same URL and confirmed `B2B Email Campaign Plan` remained in the header and conversation list.

The pre-alias browser logs contained historical HTTP 502/runtime-router errors from the stale deployment. After repointing the public alias and reloading the current bundle, the live chat turn and title persistence check passed. Keep the current alias mapping intact when publishing future Vercel production deployments.

## 2026-07-21 Tenant-Safe Pooled Runtime Beta

The six-milestone pooled-runtime implementation is code-complete on `assistant/pooled-runtime-beta`. It is deliberately disabled by default and has not been enabled for production customer traffic. No worker fleet, object-storage bucket, paid Railway capacity, or new production secret was created during implementation.

What is now implemented:

1. Authenticated tenant admission and exact-route dispatch preserve organization, user, assistant, actor, worker, lease generation, request, and conversation identity from the control plane through the gateway and assistant.
2. A bounded worker catalog, single-tenant leases, monotonic generations, request handles, health probes, startup gates, a singleton coordinator epoch, lost-ownership aborts, and exact operator recovery prevent two control-plane replicas or stale capabilities from sharing a worker.
3. Tenant state can be restored and exported through short-lived signed object URLs. Release waits for conversations, tools, streams, voice sessions, timers, child processes, and assignment-scoped caches to drain; export, checksum verification, workspace sanitization, authority revocation, and exact lease release must all succeed or the worker is quarantined.
4. BYOK model keys are encrypted in a tenant-bound control-plane vault and exposed only through request-scoped, lease-bound, revocable capabilities. Renderer responses, worker state archives, logs, and worker environment variables never contain provider keys. The current positive-validation providers are Anthropic, Fireworks, Gemini, Kimi, MiniMax `.io`, OpenAI, and OpenRouter; unsupported providers fail closed.
5. The web client supports pooled onboarding, server-side provider-key setup, bounded message polling, conversation-scoped event filtering, cancellation, and a pooled-provider settings surface without revealing secrets. Existing dedicated runtimes continue to win routing priority.
6. Admission, quotas, idle suspension, usage metrics, capacity alerts, state-object limits, and the entire worker pool are separate fail-closed startup gates. Pool configuration is rejected unless durable control-plane storage, object storage, a stable vault key, one expected control-plane replica, private worker networking, worker-derived signing keys, and healthy catalogued workers are all present.

Pooled v1 deliberately supports bounded interactive chat, transcript polling, static skill reads, and confirmation/question responses. Indefinite event streams, live voice, terminal/ACP, background schedules, subagents, executable task/work-item runs, integrations, OAuth, worker-local secret prompts, and other unreviewed surfaces remain dedicated-runtime-only or unavailable. Do not represent this branch as feature-complete parity for every Worklin surface.

Verification completed on the merged branch:

- TypeScript passed for the control plane, gateway, assistant, and web app. Merge hooks also passed repository secret scanning, generic-example checks, formatting, lint, generated OpenAPI validation, and the assistant/web type checks.
- Gateway focused suites passed `52/52`; the assistant identity/trust subset passed `29/29`, and the focused pooled authorization, drain, state, BYOK, voice-fencing, route, and persistence suites passed.
- Control-plane worker pool/startup passed `12/12`; runtime stack/startup gate passed `43/43`; vault passed `14/14`; request router passed `28/28`; production coordinator passed `11/11`; production transport passed `22/22`; workspace management passed `7/7`; runtime tenant tests passed `3/3`; and brand research passed `3/3`.
- The two-tenant canary, singleton coordinator, stale-token rejection, cancellation, state checkpoint, secret-leakage, workspace-quota, and five-customer isolated-launch paths passed their focused suites. A large mixed Bun invocation is not a canonical gate because global module mocks contaminate unrelated suites; run the documented focused files in separate processes.
- After merging `637afb1`, all four package type checks passed again. The changed control-plane provisioning suite passed `14/14`, the pooled index bridge passed `1/1`, and runtime stack/startup passed `43/43`. Run separately, the changed web billing, sound, voice, and Work deletion suites passed `6/6`, `5/5`, `4/4`, and `5/5`; combining those files in one Bun process reproduced the known global-module-mock contamination and is not a product failure.
- PR `#139` initially exposed two sync guards: the CLI environment mirror omitted Kimi's documented `MOONSHOT_API_KEY`, and the gateway schema guard treated optional trailing slashes on regex-derived assistant routes as path drift. Commit `38d9c74` restores the provider map and normalizes only regex-derived route comparisons; literal routes retain strict slash matching. Focused CLI parity passed `1/1`, gateway schema guard passed `7/7`, and both package type/lint/format checks passed.
- After merging assistant-scoped privacy persistence from `8740a97`, control-plane consent/store/tenant tests passed `15/15`, pooled index routing passed `1/1`, provisioning passed `14/14`, the isolated web consent API passed `2/2`, and all four package type checks passed. The merge preserves both per-assistant `admin_access_consented` state and the pooled rule that renderer payloads receive no platform actor token.
- The next PR cycle exposed five assistant-suite sync regressions: a hard-coded pooled assistant ID, missing web-search title extraction, an incomplete shell-observability mock, a stale wake-intent structural assertion, and a stale reviewed workspace-migration tail. Commits `b0e11f3` and `4ae3552` fix those exact failures. Focused reruns passed pooled auth `15/15`, title service `29/29`, title hooks `22/22`, provider routing `9/9`, shell/wake/surface-action regressions `43/43`, pooled state `24/24`, and migration 104 `7/7`.
- Merge `fc3f388` reconciles conversation-title and runtime-action work from `1035737`. Merge `fdf700b` then brings in production storage recovery and database protection through `e4cdc3a`. The combined branch preserves request-bound pooled title generation, BYOK-only title fallback, null pooled ingress/token payloads, unsupported pooled runtime actions, idle-worker readiness without opening a tenant database, restored-state integrity checks, and dedicated-Railway recovery after a failed readiness probe.
- Pushed head `43aae19` completed the full mandatory GitHub suite: serialized assistant tests, web tests/build/lint/typecheck, gateway, CLI, local mode, Electron, OpenAPI, bundled skills, and Vercel preview all passed. This is historical evidence for that exact commit only.
- Merge `29a66ad` reconciles production title reliability from `614715f` without weakening pooled isolation. Interactive title resolution retries only user-owned BYOK profiles, failed generation derives a replaceable title from the user message, pooled regeneration can use request-local transcript data, and detached title jobs remain forbidden on pooled workers. Focused verification passed title service `31/31`, title hooks `22/22`, provider routing `9/9`, pooled state lifecycle `24/24`, assistant TypeScript, ESLint, and Prettier. Merge hooks passed secret scanning, generic-example checks, formatting, lint, and assistant type checking. A fresh full GitHub CI run on the pushed current head remains mandatory.

Release sequence:

1. Push merge `29a66ad` plus this handoff refresh to draft PR `#139`, verify `origin/main` has not advanced again, and require every mandatory CI check to pass with all pool gates disabled.
2. Deploy the code with the existing dedicated and pre-provisioned paths unchanged. Verify signup, consent, BYOK configuration, assistant creation, typed chat, persistence, skills, approvals, task handling, and the existing voice pilot in the authenticated Logarn Chrome profile.
3. Only with explicit infrastructure authorization, create a new private pooled worker and tenant-state bucket, configure stable server-only secrets, and start with one worker and global concurrency `1`. Never repurpose a customer-bound runtime.
4. Run two tenants sequentially through that worker, prove no identity, credential, message, file, approval, browser, object-path, or voice-state leakage, replay all stale capabilities and require rejection, then test restart quarantine and exact operator recovery.
5. Expand to five independent test users only after the two-tenant canary passes. Keep pooled voice and the unsupported surfaces above off until they receive the same tenant- and generation-bound treatment.

Until steps 2 through 4 pass against production infrastructure, the honest status is: **the scalable runtime is implemented and locally verified, but production multi-user pooled execution is not yet enabled or customer-ready.**

## 2026-07-20 Permanent Owner Binding Fix

The production error `Authenticated owner identity is not bound to this assistant` was caused by the runtime using one shared `vellum` guardian contact as the owner for every web request. A newly signed-up user could have a valid, assistant-scoped actor token and still be rejected because that user was not the principal stored in the shared guardian row.

PR `#117` merged as `2023b16`. The runtime now resolves a gateway-verified platform owner directly from the current request before consulting the shared contacts database:

- The gateway validates the signed actor token and assistant scope, strips any caller-supplied `x-vellum-platform-owner` value, and sets that marker only for a verified platform-owner request.
- The conversation and surface-action routes trust the namespaced `vellum-principal-*` actor from that verified request as the guardian for that turn. User A and user B therefore receive independent trust contexts on the same pooled runtime.
- External-channel identities and legacy owner bindings still use the existing contact resolver and constrained drift healer. The immutable owner-A-versus-owner-B guard remains in place.

Verification completed before merge:

- Assistant: 43 focused tests passed, including two independent platform owners and the existing guardian immutability suite; TypeScript passed.
- Gateway: 56 focused tests passed, including forged-marker stripping and tenant/assistant scope rejection; TypeScript passed.
- Control plane: 54 focused tests passed, including separate default assistants and runtime routes for separate users; TypeScript passed.
- Repository lint, formatting, OpenAPI, and Vercel preview checks passed. The serialized repository-wide assistant test job subsequently passed in the PR #128 release checks; retain the live authenticated turn as the remaining product-level acceptance gate.

Post-merge deployment check: the public Railway control plane returned HTTP 200 from `/readyz` with `runtimeMode: "control-plane"` and `provisionerReady: true`. A live authenticated chat turn remains the final acceptance check. The available in-app browser was signed out, and the Chrome extension bridge was unavailable despite Chrome and the extension being installed; do not bypass this with credentials or a different user account. Resume by signing in with the intended production user, send one ordinary message, and confirm the old owner-binding error does not appear.

## 2026-07-20 Provisioning Timeout Recovery

The production browser can remain on `Assistant is provisioning` / `Setting up your assistant...` when the runtime provisioner has stalled or taken longer than the client polling window. The control plane already exposes the assistant-scoped `POST /v1/assistants/:id/restart/` recovery route (deployed in `d248440`), but the web client previously treated a five-minute initializing timeout as a plain re-poll. That meant a user could be left in an effectively permanent setup loop.

The web fix makes the timeout state actionable for every user:

- After the five-minute watchdog expires, the client shows `Your assistant is taking longer than expected to start. Try again to restart setup.`
- The retry action is tagged `restart_runtime`, so it invokes the assistant-scoped restart endpoint and then resumes normal lifecycle polling.
- A failed restart keeps the recovery action available and presents the backend's user-safe error message.

The fix is in `apps/web/src/assistant/lifecycle.ts` with a focused watchdog assertion in `apps/web/src/assistant/lifecycle-service.test.ts`. PR `#128` passed repository Test, Lint, Type Check, Build, and Vercel checks. Production verification fetched the public lazy lifecycle bundle and confirmed both `restart_runtime` and the new timeout copy; Railway `/healthz` returned release `d248440` and `/readyz` returned `runtimeMode: "control-plane"` with `provisionerReady: true`. A real authenticated provisioning-to-chat turn remains the final browser acceptance check.

## P0: Production Task Handling And Live-Voice Model Resolution

Authenticated production acceptance in the user-selected Logarn Chrome profile on 2026-07-16 established a mixed result on the existing private-pilot assistant:

- Authentication, assistant bootstrap, the full dashboard, conversation creation, and transcript persistence loaded normally.
- A fresh low-cost BYOK text turn succeeded immediately and returned the exact requested response.
- The bundled `weather` skill loaded successfully. The visible execution trace reported `Using a skill`, and the assistant returned the exact metadata description from `skills/weather/SKILL.md` without calling an external weather service.
- The bundled `tasks` skill did not complete its read-only list operation. The runtime reported that the `assistant` CLI was not on `PATH` and no usable script existed in `bin/`, so it could not determine the number of open tasks. No task was created, changed, completed, or deleted.
- The large royal-blue orb correctly initiated Live Voice and the panel advanced from `Ready` to `Connecting`. The Worklin LLM stage then failed with HTTP 404 because the voice turn resolved Fireworks model `accounts/fireworks/models/minimax-m3`, which the configured BYOK account/team cannot access. The panel returned to `Ready` and released the session.

This updates the earlier ElevenLabs diagnosis. The transport path remains production-proven, but the release blocker is broader than the earlier Kimi/`claude-sonnet-4-6` pairing: voice is not reliably inheriting a usable active BYOK conversation profile. Typed chat can succeed while voice resolves a different inaccessible provider/model pair. Do not mask this by switching the user to a Worklin-managed profile.

Required fixes and release gate:

1. Make the live-voice Worklin LLM turn inherit the same validated active BYOK model profile as the bound conversation, or require an explicit supported BYOK voice profile. Reject an inaccessible provider/model during bootstrap before opening a billed microphone/provider session.
2. Make the bundled `tasks` skill executable in the production runtime. Either package the supported `assistant` CLI entrypoint on `PATH` or replace the skill's CLI dependency with the daemon IPC/API contract; do not add an ad hoc second task store.
3. Add focused production-image tests that run the actual `tasks` read path and the voice profile resolver, including a case where typed chat and voice would otherwise diverge.
4. Rerun authenticated production acceptance: one typed BYOK turn, one bundled skill load, a read-only open-task count, and a three-turn ElevenLabs session with audible replies persisted into the same conversation.

Do not declare task handling or Release B demo-ready until these checks pass in production.

## P0: Multi-User Agent Runtime Capacity

This remains a release-blocking product problem, not a voice-only follow-up. Production still routes each customer assistant to a dedicated, pre-provisioned, or tightly allowlisted legacy runtime. The tenant-safe pooled execution plane is now implemented on `assistant/pooled-runtime-beta`, but every pool gate remains disabled and no production worker or state store exists yet. Automatic Railway provisioning also remains unavailable while the project-scoped-token/account gate described below is unresolved. Never create apparent capacity by widening the legacy shared-runtime allowlist.

### Immediate one-customer bridge

The bounded production bridge reuses one existing stopped Railway service as a pre-provisioned isolated runtime slot:

- `WORKLIN_PREPROVISIONED_RUNTIME_SLOTS` declares only operator-prepared private runtime slots; it contains no provider or customer credentials.
- The first consented assistant whose stack is still unallocated may atomically claim the available slot. Stack assignment is unique and persisted in the control-plane database.
- The isolated gateway runs with `RUNTIME_ASSISTANT_SCOPE_MODE=claim_once`. Its first valid signed actor request persists the assistant identity on the dedicated volume. Repeated requests for that assistant are idempotent; every different assistant is rejected before reaching the daemon.
- The runtime has its own volume, workspace, assistant database, gateway security directory, and credential-executor storage. It does not share customer state with the private voice-pilot assistant.
- Once the single slot is assigned, later assistants remain unallocated and fail closed. Never widen the legacy shared-runtime allowlist to create capacity.

This bridge is enough for one real customer while Railway project-token issuance is blocked. It is not the scalable architecture and must not be represented as general multi-user capacity.

Production status on 2026-07-15:

- PR `#113` merged to `main` as `d96c0aa`. Railway's two successful production deployments were built from the equivalent application code at `65ff168`; the later branch commit and squash only finalized this handoff and repository history.
- The existing stopped service was configured as an isolated `claim_once` runtime and received its own 500 MB volume. No API key or customer identity is stored in its service configuration.
- Railway deployment `d779d8d9-2c62-4652-8cd2-f30e67fda61d` completed successfully for the private customer runtime. Its full `/readyz` healthcheck passed and one replica is running.
- Railway deployment `657367ac-fcd5-4790-b2df-cb8247cf7103` completed successfully for the main Worklin control plane with exactly one pre-provisioned slot registered. Public `/healthz` returned `{"ok":true}` and `/readyz` returned `{"ok":true,"gatewayStatus":200}`.
- The slot is intentionally unclaimed. Do not consume it with a test assistant; the next consented new assistant should be the real customer.
- Qdrant cannot start in the small reserved runtime and degrades as designed with dense embeddings disabled. Treat advanced vector-memory behavior as unavailable on this bridge; verify normal BYOK chat, SQLite-backed state, skills, tools, and persistence with the customer before describing those behaviors as accepted.
- Railway project-token creation remains blocked by account verification. The automatic per-assistant Railway provisioner remains inert, and the project still has limited trial credit. Monitor usage while the second service is running.

### Pooled release gate that must remain on every future handoff

The tenant-safe pooled execution plane is implemented and locally verified on `assistant/pooled-runtime-beta`, with current production source `614715f` merged in `29a66ad`. The task remains P0 until the infrastructure and product acceptance gates pass. Do not close it until all of the following are true:

1. Arbitrary new users can complete signup, consent, BYOK provider setup, assistant creation, and a real agent turn without an operator editing infrastructure.
2. Every request carries authenticated organization, user, and assistant context through conversation, memory, credential, file, artifact, tool, background-job, and voice-session operations.
3. Cross-tenant reads, writes, credential use, tool execution, event delivery, and file access fail closed under an adversarial two-tenant test suite.
4. Risky code and host-tool work uses an ephemeral tenant-scoped sandbox; ordinary turns use a shared worker pool rather than a permanent service per user.
5. Per-tenant concurrency limits, rate limits, storage quotas, idle suspension, usage metrics, and operator-visible capacity alerts are enforced.
6. BYOK credentials remain server-side and tenant-scoped. Worklin-managed model or voice billing stays deferred until explicitly reopened.
7. The private pilot assistant and this pre-provisioned customer slot have a tested migration path, after which `legacy_shared`, `claim_once`, and `WORKLIN_PREPROVISIONED_RUNTIME_SLOTS` can be removed.

Minimum pooled-beta gate: two independently authenticated tenants run sequential multi-turn BYOK conversations through the same single-concurrency worker, then stale actor, service, model-key, conversation, assistant, organization, artifact, and credential capabilities are replayed and rejected. Test restart quarantine and exact operator recovery before adding a second worker.

Full customer-parity gate: multiple independently authenticated users run simultaneous multi-turn conversations and tool tasks, including the surfaces deliberately excluded from pooled v1, and adversarial identifier swaps cannot cross the tenant boundary. Do not claim full Worklin parity while live voice, executable tasks, terminal/ACP, background work, integrations, or other excluded surfaces still require a dedicated runtime.

Immediate customer acceptance sequence:

1. Let the real customer use the normal production URL and complete signup, terms, consent, and BYOK provider setup themselves.
2. Confirm their assistant reports `runtime_provider: "preprovisioned"` and `runtime_status: "active"`; do not expose their identifiers in this handoff.
3. Run a typed multi-turn BYOK conversation, refresh and confirm persistence, load one bundled skill, execute one read-only tool, and verify an approval-required action still pauses safely.
4. Confirm the reserved runtime logs one first-assistant claim and never changes identity afterward.
5. After the slot is claimed, verify another assistant cannot reach that daemon and cannot inherit its conversation, credential, workspace, memory, or event state.
6. Monitor Railway credit and stop the reserved service only if the customer no longer needs access; stopping it removes availability but preserves its dedicated volume.

## 2026-07-15 Assistant Wake-Up Hotfix

PR `#111` merged as `4dacb43e84557e7a453ab9965e2abefb4be4b72d` and was deployed to Railway production as deployment `deb8bc93-6a74-4237-9757-6467a6122899` with message `Accept slashless control-plane routes`. Vercel reported success for the merge commit, and Railway `/readyz` returned HTTP 200 with `{"ok":true,"gatewayStatus":200}` after the deployment.

Root cause: the hosted frontend/Vercel layer normalizes `/v1/.../` requests to slashless paths such as `/v1/assistants?hosting=platform`, while the control-plane exact handlers only accepted trailing-slash paths. A signed-in browser could therefore receive `404 {"detail":"Not found."}` for assistant bootstrap even when the same account's assistant/runtime existed and was active behind Railway.

Fix: `control-plane/src/http-paths.ts` now normalizes route comparisons and protects assistant-prefix matching. `control-plane/src/index.ts` uses it for assistant, organization, user, billing, feature-flag, telemetry, and shared-artifact routes. Regression coverage lives in `control-plane/src/http-paths.test.ts`.

Verification:

- `bun test src/http-paths.test.ts src/runtime-stacks.test.ts` passed in `control-plane`.
- `bunx tsc --noEmit` passed in `control-plane`.
- `git diff --check` passed.
- Targeted ESLint is not configured for `control-plane`; attempting it reports no ESLint config for that package.
- Authenticated Chrome production probe after Railway deployment: `/v1/assistants?hosting=platform` returned HTTP 200 with one active assistant, and `/v1/assistants/active` returned HTTP 200 with `runtime_status: "active"` and `runtime_provider: "legacy_shared"`.
- Live browser flow using the disposable xAI provider key progressed through provider setup, prechat onboarding, and into conversation `3be75ebd-5117-4325-a700-7024d0d39d7b`. A simple production chat turn succeeded; the assistant replied with a short confirmation.

Product note: logging into Worklin with the same Gmail/Auth0 account should map to the same Worklin user and should not be device-bound. The post-login confusion observed here was not an intentional cross-device restriction; it was a route/bootstrap failure plus a separate UX issue where choosing `ChatGPT Subscription` requires a second ChatGPT provider authorization before first chat. The current onboarding also has several skippable setup gates before the main conversation UI, which can still feel like the assistant is not ready even after the backend wake path is fixed.

## Collaborative Artifacts Implementation — Production

PR `#82` merged as `aca7f272` on 2026-07-14 and is deployed to production. Vercel deployment `worklin-q4uu3h5rs-sautionlineai-3596s-projects.vercel.app` completed successfully, and the manually pinned `worklin-ai.vercel.app` alias was repointed to it. Railway completed successfully; `/healthz` and `/readyz` return HTTP 200 with gateway status 200.

- The Campaign Copybook skill now requires the document editor, reuses the month creation result's `documentSurfaceId`, opens that document, and persists with `document_update`. It explicitly forbids duplicate documents, `file_write`, `host_file_write`, Markdown workspace files, and full-copy chat fallbacks. Persistence failure retains retry state and does not advance approval gates.
- Migration 293 adds an additive artifact registry. Copybooks are registered deterministically, ordinary documents inherit only explicit conversation brand scope, Copybook month documents are excluded from root results, and ambiguous resources remain Unassigned.
- New assistant APIs provide brand summaries plus artifact list, detail, and classification/favorite/archive updates. Partial and missing source states remain recoverable.
- The web sidebar replaces Library and Copybooks with Work. `/assistant/work` chooses a brand and `/assistant/work/brands/:brandId/artifacts` renders the mixed Artifacts collection. Legacy Library and Copybook routes replace-redirect to the canonical Work routes.
- Copybook documents remain directly human-editable with anchored comments. “Work with Worklin” opens the same document beside its conversation and supplies the active month, campaign, selected target, and unresolved-comment context for targeted revisions.

Verified before merge: 21 focused assistant tests, 23 focused web tests, assistant and web TypeScript, focused lint, OpenAPI freshness, `git diff --check`, production-mode web build, the full web workflow, Campaign Copybook skill checks, catalog validation, and Vercel preview. The full assistant suite still has unrelated baseline failures across untouched guard/runtime files, while every new Copybook and Artifact test passes. True multi-user live cursors/presence and persisted four-role team enforcement still require a team/realtime collaboration service and must not be represented as shipped by this slice.

Authenticated Chrome acceptance on the user-selected Profile 2 confirmed:

- The global sidebar contains `Work` and no standalone Library or Copybooks entries.
- `/assistant/work` auto-opens Seamossonly at `/assistant/work/brands/brand_b56bab4e813e4dc3cf731750/artifacts`.
- The Artifacts page exposes All, Copy, Design, Images, Video, Social, Apps, and Documents filters plus search and `Create with Worklin`.
- Legacy `/assistant/library` and `/assistant/copybooks` routes replace-redirect to `/assistant/work`.
- The live August 2026 Copybook request reached the hardened workflow, but `copybook_list` and document creation failed closed because the control plane minted the raw platform user ID as the actor principal while runtime startup generated a `vellum-principal-*` owner binding. Worklin did not call `file_write`, create a duplicate document, or dump 15 emails into chat.

Owner binding repair is implemented locally on branch `assistant/fix-hosted-owner-binding`: every authenticated platform user maps deterministically to `vellum-principal-<userId>` as the default owner of each assistant created for that user. The existing constrained drift healer can then replace only an auto-generated startup binding; arbitrary external principals remain rejected. Conversation ingress now rejects an authenticated actor that remains unbound after healing instead of continuing with `unknown` trust. Targeted control-plane and assistant tests and both package type checks pass. After deployment, resume conversation `3f67e958-4729-4ea8-ba13-672d716ada93`; create the August 2026 month for Seamossonly, persist through `document_open`/`document_update`, and stop at strategy approval before briefs or copy.

## LLM-First Conversation Routing

Natural-language messages now reach the agent loop before Worklin decides whether the user wants onboarding, a connection, an audit, copy, or another workflow. Deterministic code may still enforce permissions and explicit slash commands, but it no longer authors conversational onboarding replies.

The production failure had two independent causes:

- The HTTP message route and daemon foreground/background/queue paths intercepted retention-shaped language and returned saved onboarding responses without calling an LLM. The first-turn wake-up path could also return a canned onboarding greeting.
- After LLM-first routing exposed the real copy workflow, the actor pre-execution gate treated read-only `brand_brain_read` as a generic host tool and denied it before the approval policy's safe-read exemption could run.

Deployed fixes:

- `f5b99c5` removes natural-language retention interceptors from the HTTP, foreground, background, single-queue, and batched-queue paths. First-turn wake-up messages also proceed through LLM inference instead of a canned response.
- `919abb2` exempts only read-only `brand_brain_read` from the earlier actor host-tool gate. Brand Brain corrections, campaign writes, files, shell commands, integrations, and other actions retain their existing permission behavior.

Local verification on 2026-07-14:

- 123 focused routing, HTTP parity, queue, retention-intent, and first-turn tests passed.
- 205 focused executor, approval-policy, Brand Brain, and real `skill_load` tests passed.
- Assistant TypeScript, targeted ESLint, formatting, secret scanning, and `git diff --check` passed.

Authenticated production verification in the user-selected Lorgan Chrome profile:

- The prior Dr Rachael copy attempt produced a saved onboarding reply and the inspector showed `0 LLM calls`.
- After deployment, the same prompt completed through Kimi `kimi-k2.6` with three LLM calls and a final `no_tool_calls` loop exit.
- The trace loaded `write-brand-copy`, read its email references, and executed `brand_brain_read` without an approval denial.
- Worklin correctly reported that the account's only persisted Brand Brain is for `Seamossonly`, not Worklin, then produced the requested Dr Rachael email using a direct evidence-led Worklin voice instead of forcing onboarding or inventing a matching saved profile.
- Verified production conversation: `0d13a814-d204-42bb-b3e5-b9f48c14674d`.

Vercel and Railway both reported success for `919abb2`; Railway `/healthz` and `/readyz` returned HTTP 200 after the process replacement completed.

## Current Skills And System-Access Fix

The existing Worklin system-access settings remain the single permission model. The deployed fix does not add a second permissions UI or a new account type.

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

Deployment status: pushed and deployed through `b7d9943` on 2026-07-14. Vercel and Railway both reported success; Railway `/healthz` and `/readyz` returned HTTP 200 with gateway status 200. A fresh production text turn succeeded after the earlier `17d2e6e`/`12e8567` restart. Run one fresh authenticated text turn before relying on LLM credential persistence across the later `b7d9943` restart.

## Default Skill Availability

Worklin-owned skills are product content, not per-user installations. Every user receives the complete first-party catalog, and the agent loads the relevant instructions on demand when a task matches. Loading is activation for the current conversation; it is not an install flow.

- The local runtime catalog contains 89 bundled skills: 68 product skills from repo-level `skills/` plus 21 internal tool-bearing skills from `assistant/src/config/bundled-skills/`.
- All 68 product skills ship in the production Docker context and resolve through `VELLUM_FIRST_PARTY_SKILLS_DIR=/app/skills`.
- Both macOS release architectures package the same `first-party-skills` resource directory.
- First-party skills appear as `bundled` in the skills API/UI, so users are not asked to install them.
- Relevant skills remain discoverable through capability-memory seeding and can be activated with `skill_load` when a task calls for them.
- Community and genuinely external skills may still use the existing installation path; that path is no longer required for Worklin's built-in catalog.

Verified locally on 2026-07-14:

- Both skill-spec linters passed: 68 product skills and 21 internal skills.
- The regenerated 68-entry offline catalog passes the drift check, including from a repo path containing spaces.
- A direct catalog probe returned 89 total skills, all 89 bundled, with zero invalid tool manifests.
- Exhaustive coverage loaded every product skill without creating a user workspace installation.
- 176 focused catalog, `skill_load`, tool-projection, registry, and search tests passed.
- Assistant TypeScript and staged pre-commit lint/type checks passed.
- Docker CLI validation could not run on this Mac because `docker` is not installed; Dockerfile paths and runtime env wiring were reviewed statically and remain subject to the production builder.

Core files:

- `assistant/src/config/skills.ts`
- `assistant/src/skills/catalog-install.ts`
- `.dockerignore`
- `runtime/Dockerfile`
- `assistant/Dockerfile`
- `.github/workflows/release.yml`
- `skills/catalog.json`

Deployment status: `b7d9943` completed successfully on both Vercel and Railway. Production still needs a direct catalog/load verification confirming that all first-party skills appear as bundled and activate without a per-user install flow. The macOS workflow did not reach compilation because its GitHub App token step is missing the App ID secret; this is a CI configuration failure, not evidence that the packaged skills failed to build.

### Post-Deploy Verification Attempt On 2026-07-14

- The user-selected authenticated Chrome profile currently stops at `/assistant/review-terms?returnTo=%2Fassistant` with an `Updated Terms` re-acceptance screen. Both policy checkboxes are unchecked and `Continue` is disabled.
- No terms or policies were accepted on the user's behalf, and the gate was not bypassed. The authenticated production catalog/load sampling cannot continue until the user reviews and accepts or declines the updated terms.
- A source-level terminology sweep found no rendered `Guardian`, `non-guardian`, or `non guardian` account label in the Contacts UI. The legacy internal owner role is rendered as `You`; internal schema, protocol, compatibility, comments, and symbol names still retain `guardian` as intended.
- `apps/web/src/domains/contacts/components/contact-type-badge.test.tsx` passed (`1` test).
- `assistant/src/__tests__/approval-hardcoded-copy-guard.test.ts`, `assistant/src/__tests__/verification-session-intent-routing.test.ts`, and `assistant/src/channels/__tests__/types.test.ts` passed (`88` tests).
- The broader authenticated production terminology check remains pending behind the updated-terms gate.

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

## Live-Voice Discoverability And Provider Consistency — Production

Application commit `bb46a82` deployed successfully on 2026-07-14. Vercel production deployment `worklin-qdcd145zu-sautionlineai-3596s-projects.vercel.app` is ready, and the canonical `worklin-ai.vercel.app` alias now points to it.

Composer interaction changes:

- The inline voice card now has an explicit top-right close control.
- The large royal-blue orb is the primary `Start live voice` / retry action.
- The card states clearly that the microphone and provider connect only after the large orb is clicked.
- Dismissing an idle or failed card only hides it. Dismissing an active or connecting card ends the session first so a live microphone is never hidden.
- Once dismissed, the compact composer orb only reopens the card; it never starts a microphone or provider session by itself.
- The visual-review route now uses the same large-orb start, close, compact-reopen, and active-end behavior as the real composer instead of its stale bottom start control.

Settings and terminology changes:

- `Live Voice` is now a separate, private-pilot card in Models & Services with `Hume`, `ElevenLabs`, and `Worklin Native` engines.
- `Speech-to-Text` remains dictation/transcription, and `Text-to-Speech` remains read-aloud/output. Hume was not added to either unrelated catalog.
- The Developer `Live Voice Pilot` panel can securely configure either Hume or ElevenLabs. It writes provider keys to the server-side credential service and writes only provider IDs/configuration to assistant config.
- The Voice settings banner and dictation error copy now route users to the correct Models & Services terminology.

ElevenLabs readiness:

- Worklin contains the provider-neutral ElevenLabs bootstrap, server-side `credential/elevenlabs/api_key` lookup, short-lived conversation-token minting, WebRTC client adapter, transcript events, input/output amplitude sampling, interruption handling, and Speech Engine upstream bridge.
- The account, scoped key, Speech Engine, server-side configuration, private-pilot allowlist, browser connection, and public upstream route are configured. Production has now reached `Listening`, accepted the ElevenLabs upstream WebSocket, and advanced into the normal Worklin LLM turn.
- Release B is not complete. The active pilot assistant's selected model is currently rejected by Kimi before an assistant reply can be synthesized, and the continuous-turn, interruption, persistence, approval, overlay-parity, and latency gates remain outstanding.

Implementation and production verification on 2026-07-14:

- 77 focused tests passed in separate Bun processes with zero failures.
- Web TypeScript passed.
- Targeted ESLint reported zero errors and one pre-existing `slash` dependency warning in `chat-composer.tsx`.
- The default Vite runner loader failed before application compilation with `Vite module runner has been closed`; the equivalent production build passed with `bun --bun vite build --configLoader bundle` (6,746 modules transformed).
- Chrome visual QA passed against the real dashboard preview for idle close, compact reopen without provider start, large-orb start, live transcript/Listening state, and active end-and-hide.
- `git diff --check` passed.
- Commit hooks passed secret scanning, lint, generated API clients, and web TypeScript. Lint retained only the same pre-existing `slash` dependency warning.
- GitHub's full web workflow passed lint, tests, type-checking, its aggregate gate, and notification; the Storybook build/deploy workflow also passed.
- The deployed production asset changed to `index-DhcR_r7D.js`, and the canonical production bundle contains both `Click the orb to start live voice.` and `Your microphone and voice provider connect only after you click.`
- Railway correctly skipped a new service deployment because no watched backend files changed. Its live `/healthz` and `/readyz` endpoints remained HTTP 200 with gateway status 200.
- `worklin-ai.vercel.app` was a manually pinned alias and did not move with the otherwise successful `main` deployment. It was explicitly repointed to the ready `bb46a82` deployment and reverified against the new bundle.

Primary files:

- `apps/web/src/domains/chat/components/chat-composer/chat-composer.tsx`
- `apps/web/src/domains/chat/components/live-voice-button.tsx`
- `apps/web/src/domains/chat/voice/live-voice/live-voice-ui-store.ts`
- `apps/web/src/domains/chat/voice/live-voice/voice-conversation-panel.tsx`
- `apps/web/src/domains/chat/voice/live-voice/voice-preview-page.tsx`
- `apps/web/src/domains/settings/ai/live-voice-card.tsx`
- `apps/web/src/domains/settings/components/panels/live-voice-pilot-panel.tsx`
- `apps/web/src/domains/settings/pages/voice-page.tsx`

## ElevenLabs Production Setup And First Test

ElevenLabs is configured as the current private-pilot engine for the production assistant. The scoped API credential is stored only in Worklin's server-side credential service. Never retrieve it into the renderer, repeat it in chat, or write it to source, commands, logs, or documentation.

Non-secret provider configuration:

- Speech Engine ID: `seng_9801kxgndkvqe3v93h0wmebr3bqy`
- Speech Engine upstream: `wss://worklin-ai-production.up.railway.app/v1/live-voice/providers/elevenlabs/upstream`
- Worklin engine: `elevenlabs`
- Pilot allowlist: the current authenticated user only
- Provider privacy configuration: do not retain raw voice; delete provider audio

Production commit `90c9e2d` added a small raw-TCP public edge router to the combined Railway runtime. It forwards ordinary HTTP to the internal control plane and forwards only the exact ElevenLabs Speech Engine upstream path to the loopback gateway. The private gateway is not otherwise exposed. `/healthz` and `/readyz` remain HTTP 200, and an unauthenticated public WebSocket probe reaches the gateway and receives the expected HTTP 401.

Production commit `a80ce3e` changed the browser adapter so an unexpected ElevenLabs disconnect remains visible as a failed voice state instead of silently returning to `Ready`. The canonical Vercel alias was repointed to the Ready deployment and verified to serve the new bundle.

Initial authenticated Chrome evidence on 2026-07-14:

1. Worklin session bootstrap returned HTTP 200 and minted an ElevenLabs conversation token without exposing the provider key.
2. The browser connected to ElevenLabs over WebRTC.
3. ElevenLabs supplied a provider conversation ID, and Worklin bound it to the managed session with HTTP 200.
4. The first attempts disconnected before reaching the configured Worklin upstream, which production correctly surfaced as `ElevenLabs ended the voice session: agent disconnected`.
5. The ElevenLabs account still had its included call allowance. This was not a credit-exhaustion failure.

Production commit `13729b4` now performs that diagnostic automatically before minting an ElevenLabs conversation token. It reads the configured Speech Engine with the existing server-side credential and retains only the resource ID, a query-free `wss://` host/path, whether request headers exist, and privacy booleans. It never returns or logs the API key, header values, provider response body, or raw provider URL query. Four focused resource-inspection tests, the existing ElevenLabs authorization and managed-session suites, assistant TypeScript, targeted lint, formatting, and secret scanning pass.

The GitHub push completed, but Railway's GitHub watcher did not create a deployment for `13729b4`. The authenticated Logarn Railway CLI was therefore used to upload the exact clean checkout to the existing `Worklin-ai` production service. Three tracked, broken macOS-only design-tool symlinks were excluded from that upload with a temporary `.railwayignore`; the file was removed immediately afterward and was not committed. Railway deployment `9ad89634-dae0-4071-a46a-b5e85d56357d` completed successfully on 2026-07-15, and `/healthz` plus `/readyz` both returned HTTP 200 with gateway status 200.

The user explicitly approved adding only `Speech to Speech: Access` to the existing ElevenLabs `Worklin Voice Pilot` API key. That one permission was saved; `ElevenAgents: Write` remained enabled and every unrelated endpoint family remained `No Access`. The key remains non-IP-restricted and server-side only.

The next sanitized network trace corrected the earlier diagnosis: Worklin's own bootstrap returned `403 Managed voice is limited to the private pilot`. The gateway authenticates the production owner as a canonical `vellum-principal-<userId>`, while the pre-existing pilot setting stored the legacy raw user ID. Commit `53e1416` makes canonical platform principals accept their exact legacy raw user entry without broadening access to unrelated actors. Three focused allowlist tests passed. Railway deployment `ed875147-3003-4aef-8a87-64162a0b8e44` completed successfully.

The subsequent retry progressed to `503 runtime_not_ready`. The assistant stack was failed because isolated Railway runtime capacity is intentionally capped at zero. Commit `e2ea3b6` removed the pilot assistant ID from public `railway.json`; the current assistant ID now exists only in the server-side `WORKLIN_LEGACY_SHARED_RUNTIME_ASSISTANT_IDS` variable. Railway deployment `3b4c66c8-3f38-4201-b509-d4ab54a72546` recovered exactly that assistant onto the internal shared runtime. Customer onboarding must remain gated while isolated runtime capacity is unavailable.

The recovered retry bootstrapped with HTTP 200 and ElevenLabs reached the public Speech Engine path, but the gateway's runtime upgrade returned 401. Worklin's JWT verifier matched the documented signature scheme but did not accept the optional `Bearer` prefix handled by ElevenLabs' official SDK. Commit `9970ef9` trims the API key, accepts a case-insensitive Bearer prefix plus surrounding whitespace, and validates the JWT `iat` clock-skew boundary. Ten focused authorization/resource/allowlist tests, targeted lint, full assistant TypeScript, formatting, and secret scanning passed. Railway deployment `1a145888-9100-4054-9c2d-039cdd29a9eb` completed successfully with green readiness.

Final authenticated Chrome evidence on 2026-07-15:

1. The large Worklin orb started the real production session and the panel advanced to `Listening` with `Go ahead — I’m listening.`
2. Railway logged `ElevenLabs Speech Engine upstream opened` at 08:06:15 UTC and closed it cleanly after the short test at 08:06:24 UTC. This proves the browser connection, provider token, provider conversation binding, public edge, gateway forwarding, runtime service token, provider JWT, and upstream route all passed.
3. The normal Worklin LLM turn was then attempted. Kimi rejected configured model `claude-sonnet-4-6` with HTTP 404 `Not found the model ... or Permission denied` before any assistant speech could be synthesized.
4. The panel returned to `Ready`, releasing the microphone/provider session. Do not leave silent test sessions open because provider time can still accrue.
5. No long-lived provider credential, browser session material, signed connection payload, or raw audio was written to source or this handoff.

A conventional ElevenAgents resource named `Worklin Voice Pilot` was created during initial exploration before the Speech Engine resource. It is not the configured Worklin engine and is harmless, but do not delete it without the user's confirmation.

## Current Objective And Blockers

The scalable-runtime code is complete on `assistant/pooled-runtime-beta`, but production is still on the existing dedicated/pre-provisioned routing path. Draft PR `#139` is open; current `origin/main` (`614715f`) is merged in `29a66ad`. The previous branch head `43aae19` passed the full mandatory GitHub suite, while the reconciled current head has passed its focused title/pool checks and still needs a fresh full CI cycle. After that, deploy with every pool gate disabled and complete the normal authenticated production regression. Enabling the pool then requires explicit authorization for a new private worker and object-storage bucket plus the documented one-worker, two-tenant isolation canary. Live voice and full executable task handling are not admitted to pooled v1.

Worklin remains the canonical agent brain for memory, tools, permissions, and transcript persistence. The ElevenLabs Speech Engine opens its production upstream and reaches the normal Worklin agent turn. The immediate blocker is active BYOK model-profile resolution: the earlier attempt routed `claude-sonnet-4-6` through Kimi, while the 2026-07-16 Logarn Chrome attempt routed `accounts/fireworks/models/minimax-m3` through Fireworks. Both were rejected with HTTP 404/access errors even though a typed BYOK turn in the same production conversation succeeded. Fix the typed-versus-voice profile divergence and validate the selected BYOK model before connecting the provider; do not switch the user to a Worklin-managed profile.

The Hume pilot remains independently blocked by Hume billing, not Worklin connectivity:

- Hume accepted Worklin's production WebSocket connection.
- Hume then returned error `E0300`: `Exhausted credit balance. Visit platform.hume.ai/billing to manage your account.`
- Hume Billing now shows `0 minutes remaining` and `EVI limit exceeded` on the active free plan. The account had five free EVI minutes at the start of this test; the continuously connected listening session consumed that allowance while the microphone/connection path was being diagnosed.
- The spoken multi-turn, interruption, transcript-persistence, and latency gates cannot be completed until the user adds Hume credits.
- Do not select a plan, add payment information, or alter Hume billing on the user's behalf.

## Verified Production Snapshot

Verified through 2026-07-15:

- The repository `main` and `origin/main` include production application commit `9970ef9`; this handoff refresh follows it.
- `GET https://worklin-ai-production.up.railway.app/healthz` returned HTTP 200 with `{"ok":true}`.
- `GET https://worklin-ai-production.up.railway.app/readyz` returned HTTP 200 with `{"ok":true,"gatewayStatus":200}`.
- `GET https://worklin-ai.vercel.app/assistant` returned HTTP 200.
- A second direct health pass after resuming from this handoff again returned HTTP 200 for `/healthz`, `/readyz`, and the frontend `/assistant` route.
- Vercel deployment `worklin-kjstmkc4o-sautionlineai-3596s-projects.vercel.app` completed successfully for `b7d9943`.
- Railway reported a successful production deployment for `b7d9943`.
- The OpenAPI Spec Check passed for `b7d9943`.
- The macOS Build check failed before compilation because `actions/create-github-app-token` had no App ID configured (`appId option is required`).
- Vercel deployment `worklin-exmunv6fv-sautionlineai-3596s-projects.vercel.app` completed successfully for `17d2e6e`.
- The stale `worklin-ai.vercel.app` alias was repointed to that deployment and verified to serve the same main asset bundle.
- A fresh post-restart production text turn returned `Worklin is ready.`, confirming LLM generation and credential persistence.
- The updated assistant identity, empty-chat, voice Ready panel, orb entry control, and avatar picker were verified in authenticated Chrome.
- Vercel deployment `worklin-qdcd145zu-sautionlineai-3596s-projects.vercel.app` completed successfully for `bb46a82`; `worklin-ai.vercel.app` was repointed to it and verified to serve `index-DhcR_r7D.js` with the new large-orb start guidance.
- GitHub's full web and Storybook workflows passed for `bb46a82`. Railway required no new deployment for this web-only change, and its health/readiness endpoints remained green.
- Vercel deployment `dpl_2Cup8MVp5966L4g5Yf5yaCgPKYjB` completed successfully for the error-visibility commit.
- The stale `worklin-ai.vercel.app` alias was repointed from its older deployment to that Ready production deployment.
- The corrected production UI was verified in Chrome: `Voice unavailable` and Hume's exhausted-credit message remain visible, while `Start voice mode` stays retryable.
- The production Worklin account resolves a persisted assistant; the prior zero-assistant state is fixed.
- The production Live Voice setup panel is available for the allowlisted user and stores Hume credentials through Worklin's server-side credential path.
- Hume configuration completed successfully in Worklin without exposing provider secrets to the renderer or repository.
- `90c9e2d` deployed successfully to Railway. The combined public edge preserves ordinary control-plane HTTP, exposes only the exact ElevenLabs upstream WebSocket path, and returns HTTP 401 when the provider authorization JWT is absent.
- `a80ce3e` deployed successfully to Vercel. The canonical production alias serves `index-CQJeke1Q.js`, which contains the ElevenLabs disconnect-visibility copy.
- The approved ElevenLabs key change is limited to `Speech to Speech: Access`; `ElevenAgents: Write` remains enabled and unrelated scopes remain disabled.
- `53e1416` preserved private-pilot access for the canonical platform owner while retaining compatibility with the exact legacy raw user allowlist entry.
- `e2ea3b6` moved the internal shared-runtime pilot assistant ID out of `railway.json` and into server-only Railway configuration; the current assistant recovered from `runtime_not_ready`.
- `9970ef9` aligned Worklin's Speech Engine JWT verifier with the official ElevenLabs SDK's optional Bearer-prefix handling and `iat` validation.
- Railway deployment `1a145888-9100-4054-9c2d-039cdd29a9eb` is successful and `/readyz` passed.
- The final authenticated ElevenLabs production attempt reached `Listening`; Railway logged the Speech Engine upstream open and close. The next failure is the normal LLM stage: Kimi rejects `claude-sonnet-4-6` with HTTP 404/permission denied.

Recent production commits relevant to this pilot include:

- `9970ef9` — accept ElevenLabs' optional Bearer-prefixed Speech Engine authorization and validate `iat`.
- `e2ea3b6` — keep private-pilot shared-runtime assistant IDs in server-only configuration.
- `53e1416` — preserve voice-pilot access across legacy raw and canonical platform owner principals.
- `13729b4` — verify the configured Speech Engine resource without exposing provider secrets.
- `a80ce3e` — surface unexpected ElevenLabs agent disconnects in the live-voice panel.
- `90c9e2d` — proxy the exact ElevenLabs Speech Engine upstream path through the combined Railway public edge.
- `919abb2` — allow read-only Brand Brain context through the actor pre-execution gate.
- `f5b99c5` — route every natural-language conversation path through the LLM.
- `b7d9943` — bundle the complete first-party skill catalog for every user.
- `12e8567` — refresh generated OpenAPI output and production handoff evidence.
- `17d2e6e` — deploy the system-access and assistant/live-voice UI rollout stack.
- `5653385` — unify assistant identity and live voice around the royal-blue Worklin orb.
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

The deployed fix:

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

### P0. Release the pooled-runtime code without enabling customer traffic

1. Push merge `29a66ad` and this handoff refresh to draft PR `#139`, verify `origin/main` is still `614715f`, then require all mandatory CI checks on the exact current branch head.
2. Deploy the reviewed code with every `WORKLIN_TENANT_*`, worker-catalog, worker-pool, production-transport, state-transport, and pooled-key-vault gate disabled. Confirm existing dedicated, pre-provisioned, and private-pilot routing is unchanged.
3. In the authenticated Logarn Chrome profile, verify signup/sign-in boundary behavior, consent, default-assistant creation, BYOK setup, typed multi-turn chat, refresh persistence, conversation naming, static skill load, read-only tool behavior, approval pause, task handling, and the existing voice error/success path. Record failures as separate product blockers; do not enable the pool to hide them.
4. Stop before creating infrastructure. With explicit approval, create a fresh private pooled worker and tenant-state bucket, configure stable server-only vault/recovery/signing secrets, and enable one worker with global concurrency `1`.
5. Run the documented two-tenant isolation, stale-capability replay, restart-quarantine, operator-recovery, state-export, sanitization, and no-secret-leakage canary. Expand to five test users only after it passes.

### 0. Finish post-deploy verification for skills and system access

1. User action: review the `Updated Terms` screen in the selected authenticated Chrome profile and accept or decline the policies. Do not make that choice on the user's behalf.
2. After the user has accepted the terms, query the production skills surface and confirm the complete first-party catalog appears as bundled rather than user-installed.
3. Load additional representative product skills and confirm activation does not create a workspace installation or approval prompt.
4. Complete the authenticated live terminology sweep. The source-level Contacts and approval/channel checks already passed with `89` focused tests.
5. Create or import a Worklin-specific Brand Brain only if the user wants future Worklin copy to use persisted Worklin voice rules; the current persisted profile belongs to Seamossonly.
6. Restore the missing GitHub App ID secret for the macOS workflow, then rerun that check before treating release packaging as verified.

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

### 4. Resume the ElevenLabs pilot

ElevenLabs remains disabled for general users. The account, scoped server-side credential, Speech Engine, Worklin assistant configuration, browser token flow, public upstream route, provider JWT verification, and runtime upstream are now production-proven.

1. Keep the pilot on BYOK. Production has resolved two inaccessible pairs across live attempts: Kimi/`claude-sonnet-4-6` and Fireworks/`accounts/fireworks/models/minimax-m3`. Make voice inherit the same validated active BYOK profile as the bound typed conversation, or require an explicit supported BYOK voice profile. Do not switch the conversation to a Worklin-managed profile.
2. Confirm a normal typed turn succeeds under the corrected BYOK provider/model pair before spending another voice minute.
3. Start Live Voice, confirm `Listening`, and speak a short first turn. Verify the Worklin response is both audible and persisted as the same conversation turn.
4. Run the documented three-turn, partial/final transcript, input/output visualization, barge-in, persistence, duplicate-session, approval-safety, no-raw-audio, and latency gates.
5. Keep the internal shared-runtime fallback limited to the one pilot assistant. Do not treat it as customer-ready or increase Railway runtime cost/capacity without explicit authorization.

Do not declare Release B complete until the in-app and overlay surfaces both pass the same-conversation behavioral and safety suite.

## Important Product State

- Every authenticated Worklin account should receive exactly one default assistant identity; repeated bootstrap must stay idempotent.
- Live Voice replaces one-shot dictation in the eligible composer; do not reintroduce a second microphone button.
- The shared black/royal-blue panel is used by the in-app composer and the macOS overlay.
- Listening animation uses microphone amplitude; speaking animation uses actual playback amplitude.
- Ending voice releases the microphone, audio context, provider connection, and session lease while preserving completed chat turns.
- Approval-required tools must pause and direct the user to Worklin's normal approval UI.
- The Hume pilot allowlist is written for the authenticated user, not `*`.
- Customer model access is BYOK-only for now. Worklin-managed model and voice billing, credits, quotas, and entitlements remain deferred.

## Safety Boundaries

- Never expose Hume, ElevenLabs, Auth0, Railway, Worklin, or other provider secrets to a renderer or repo file.
- Never inspect or export browser cookies, local storage contents, or browser profile data.
- Do not manage billing, accept legal terms, create paid infrastructure, or select plans for the user.
- Do not widen legacy shared-runtime access. Do not enable the new pool for customer traffic until the one-worker infrastructure and two-tenant canary pass.
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

P0 is multi-user agent-runtime capacity. The six-milestone tenant-safe pooled execution plane is implemented on `assistant/pooled-runtime-beta`, with current production source `614715f` merged in `29a66ad`. Draft PR `#139` is open. The previous pushed head `43aae19` passed every mandatory GitHub check, but the current reconciled head requires a separate fresh CI cycle before release. The branch has passed the focused tenant, lease, state, BYOK-vault, quota, coordinator, transport, stale-capability, storage-readiness, title-generation, and two-tenant security suites, but it is disabled by default and is not deployed or customer-ready. Deploy only with every pool gate disabled and regression-test the existing production paths. Do not create a worker, bucket, paid capacity, or production secrets without explicit approval. After approval, start with one new private worker and concurrency `1`; pass the sequential two-tenant isolation, stale-token replay, restart-quarantine, exact operator-recovery, export/sanitize, and no-secret-leakage canary before expansion. Pooled v1 does not admit live voice, terminal/ACP, background work, integrations, or executable task/work-item runs, so full parity remains a separate release gate.

Production still has exactly one unclaimed pre-provisioned isolated customer runtime from commit `65ff168` and Railway deployments `d779d8d9-2c62-4652-8cd2-f30e67fda61d` plus `657367ac-fcd5-4790-b2df-cb8247cf7103`. The first consented new assistant may atomically claim that slot; its gateway then permanently locks to the first valid signed assistant identity and rejects all others. Do not consume the slot with a test identity, do not add customer assistants to the legacy shared-runtime allowlist, and do not describe this as general multi-user capacity.

The current private-pilot engine is ElevenLabs. Its scoped credential is stored only in Worklin's server-side credential service. Speech Engine `seng_9801kxgndkvqe3v93h0wmebr3bqy` is configured with upstream `wss://worklin-ai-production.up.railway.app/v1/live-voice/providers/elevenlabs/upstream`. The approved key scopes are `ElevenAgents: Write` and `Speech to Speech: Access`; unrelated scopes remain disabled. Never expose or retrieve the key.

The ElevenLabs production transport now works end to end. `53e1416` fixed legacy-versus-canonical owner allowlist matching, `e2ea3b6` moved the single pilot shared-runtime assistant ID into server-only Railway configuration, and `9970ef9` aligned Worklin's Speech Engine JWT verifier with ElevenLabs' optional Bearer prefix. Railway deployment `1a145888-9100-4054-9c2d-039cdd29a9eb` is healthy. Authenticated Chrome reached `Listening`, and Railway logged the ElevenLabs Speech Engine upstream opening and closing. The immediate blocker is now the normal Worklin LLM stage: Kimi rejects configured model `claude-sonnet-4-6` with HTTP 404/permission denied. Keep the pilot on BYOK, select a model supported by the configured provider, verify one typed turn, then rerun voice. Do not silently switch to a Worklin-managed profile.

Newer authenticated Logarn Chrome evidence from 2026-07-16 proves that ordinary BYOK chat and bundled skill loading work, but two P0 acceptance paths still fail. The bundled `tasks` skill cannot perform a read-only list because the production runtime does not expose its documented `assistant` CLI command. Live Voice advances to `Connecting` but then resolves Fireworks `accounts/fireworks/models/minimax-m3`, which the configured account cannot access, despite typed chat succeeding in the same conversation. Treat this as typed-versus-voice active-profile divergence, add an inaccessible-model preflight before provider connection, and keep the task-runtime repair in every future handoff until both paths pass production acceptance.

The Hume path is also configured and its connectivity is proven: Worklin bootstrap returned 200, Hume WebSocket returned 101, session_settings/chat_metadata exchanged, Chrome granted the built-in microphone, Worklin showed Listening, and 16 kHz audio_input frames streamed. Hume is independently blocked by error E0300: exhausted credit balance. Stop at that billing gate; the user must add credits.

The app previously hid the provider error because ChatComposer unmounted VoiceConversationPanel for failed state. The deployed fix keeps the failed panel visible with Voice unavailable plus the provider message while leaving the retry button available. Preserve all unrelated worktree changes.

Production application behavior is currently recorded at `614715f` in the Start Here section; the pooled branch has not changed that deployed fact. Natural-language messages, including first-turn wake-up, onboarding, connection, audit, and copy requests, reach the LLM instead of saved response interceptors. Worklin's existing system-access settings allow plain/catalog skill loading plus read-only Brand Brain access without an approval prompt, while Brand Brain mutations and other tools/actions still follow the selected access level. The authenticated Dr Rachael production test completed through three Kimi calls, loaded `write-brand-copy`, read Brand Brain without denial, reported the truthful Seamossonly-versus-Worklin profile mismatch, and returned the requested email. The complete first-party catalog is bundled for every user. The live-voice card has explicit close/reopen behavior, large-orb start guidance, and Hume/ElevenLabs/Native settings consistency in production. Vercel and Railway were healthy at the last recorded check. The source-level Contacts and approval/channel terminology checks passed with `89` focused tests, but broader production catalog/load sampling and the live terminology sweep were blocked in another Chrome profile by an `Updated Terms` re-acceptance screen. Stop there until the user reviews and accepts or declines the policies. The macOS workflow is blocked before compilation by a missing GitHub App ID secret.

After either provider can sustain a session, run the documented three-turn test, real-time transcript check, output-driven speaking visualization check, barge-in latency measurement, end-session and refresh persistence checks, duplicate-session rejection, approval safety test, and no-raw-audio confirmation. Use the authenticated Chrome profile requested by the user; do not switch to Safari or the in-app browser. Never repeat or expose provider credentials.
```
